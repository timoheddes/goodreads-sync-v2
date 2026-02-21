import { mkdirSync, copyFileSync, unlinkSync, readdirSync, statSync, readFileSync, existsSync, renameSync, createWriteStream } from 'fs';
import { join, basename, dirname, extname } from 'path';
import { pipeline } from 'stream/promises';
import { schedule } from 'node-cron';
import Parser from 'rss-parser';
import axios from 'axios';
import { load } from 'cheerio';
import { launch } from 'puppeteer-core';

import { DB_PATH, CRON_SCHEDULE, AA_API_KEY, FLARESOLVERR_URL, MAX_ATTEMPTS, QUEUE_COOLDOWN_MS, MAX_DOWNLOADS_PER_USER_PER_DAY, MAX_DOWNLOADS_PER_DAY, SMTP_HOST, SMTP_PORT, SMTP_FROM, AA_DOMAINS } from './config.js';

import { log, logError, logWarn } from './logging.js';
import { sanitizeFilename, sleep, fixOwnership } from './utils.js';
import { sendDownloadNotification } from './mailer.js';
import { initDb, stmts, db } from './db.js';


// --- RSS SYNC ---
const rssParser = new Parser({
  customFields: {
    item: [
      ['book_id', 'book_id'],
      ['isbn', 'isbn'],
      ['author_name', 'author_name'],
    ],
  },
});

async function syncRSS() {
  log('📚 Syncing RSS feeds...');
  const users = stmts.getUsers.all();

  if (users.length === 0) {
    log('🚨 No users configured. Add users with: node src/add-user.js');
    return;
  }

  log(`👥 Found ${users.length} user(s): ${users.map(u => u.name).join(', ')}`);

  for (const user of users) {
    try {
      const feedUrl = `https://www.goodreads.com/review/list_rss/${user.goodreads_id}?shelf=to-read`;
      log(`📡 [RSS] Fetching feed for ${user.name} (Goodreads ID: ${user.goodreads_id})`);
      const feed = await rssParser.parseURL(feedUrl);
      log(`📡 [RSS] Feed returned ${feed.items.length} item(s) for ${user.name}`);

      let newBooks = 0;
      let existingBooks = 0;
      let skipped = 0;

      for (const item of feed.items) {
        // Extract Goodreads book_id -- this is our primary dedup key
        const goodreadsBookId = item.book_id || null;
        if (!goodreadsBookId) {
          logWarn(`[RSS] Skipping feed item without book_id: "${item.title || 'unknown'}"`);
          skipped++;
          continue;
        }

        // Try multiple ISBN sources:
        // 1. Direct <isbn> element from RSS
        // 2. isbn13 from description CDATA
        let isbn = null;
        if (item.isbn && item.isbn.trim().length > 0) {
          isbn = item.isbn.trim();
        }
        if (!isbn && item.content) {
          const isbn13Match = item.content.match(/isbn13:\s*(\d{13})/);
          if (isbn13Match) isbn = isbn13Match[1];
        }

        const title = item.title || null;
        const author = item.author_name || item.creator || null;

        // Check if book already exists before upsert to distinguish new vs existing
        const existing = stmts.getBookByGoodreadsId.get(goodreadsBookId);

        // Upsert book using goodreads_book_id as the unique key
        stmts.upsertBookByGoodreadsId.run(goodreadsBookId, isbn, title, author);

        // Get the book ID
        const book = stmts.getBookByGoodreadsId.get(goodreadsBookId);
        if (!book) {
          logWarn(`[RSS] Could not retrieve book after upsert (goodreads_book_id: ${goodreadsBookId})`);
          continue;
        }

        // Link user to book
        stmts.linkUserBook.run(user.id, book.id);

        if (existing) {
          existingBooks++;
        } else {
          newBooks++;
          log(`📗 [RSS] New book queued: "${title}" by ${author || '?'} (goodreads_book_id: ${goodreadsBookId})`);
        }
      }

      log(`📊 [RSS] ${user.name}: ${newBooks} new, ${existingBooks} existing, ${skipped} skipped`);
    } catch (err) {
      logError(`[RSS] Failed to sync user ${user.name}`, err);
    }
  }
}

// --- QUEUE PROCESSING ---

async function processQueue() {
  log('🔄 Processing queue...');

  // Log queue depth for visibility
  const pendingCount = db.prepare(`SELECT COUNT(*) as cnt FROM books WHERE status = 'pending' AND attempts < ?`).get(MAX_ATTEMPTS);
  const failedCount = db.prepare(`SELECT COUNT(*) as cnt FROM books WHERE status = 'failed'`).get();
  const todayCount = stmts.countDownloadsToday.get();
  log(`📊 [Queue] ${pendingCount.cnt} pending, ${failedCount.cnt} permanently failed, ${todayCount.cnt}/${MAX_DOWNLOADS_PER_DAY} downloaded today`);

  // Check overall daily limit before starting
  if (todayCount.cnt >= MAX_DOWNLOADS_PER_DAY) {
    log(`🛑 [Queue] Daily download limit reached (${MAX_DOWNLOADS_PER_DAY}). Skipping queue until tomorrow.`);
    return;
  }

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let skippedLimit = 0;
  const skippedBookIds = [];
  const downloadedPerUser = new Map(); // userId -> { user, books[] }

  // Check per-user daily limits once upfront and log a single message per user at limit
  const rateLimitedUserIds = new Set();
  for (const user of stmts.getUsers.all()) {
    const userCount = stmts.countUserDownloadsToday.get(user.id).cnt;
    if (userCount >= MAX_DOWNLOADS_PER_USER_PER_DAY) {
      rateLimitedUserIds.add(user.id);
      log(`🛑 [Queue] User "${user.name}" has reached their daily limit (${userCount}/${MAX_DOWNLOADS_PER_USER_PER_DAY}). Skipping their books.`);
    }
  }

  while (true) {
    // Re-check overall daily limit after each download
    const dailyCount = stmts.countDownloadsToday.get().cnt;
    if (dailyCount >= MAX_DOWNLOADS_PER_DAY) {
      log(`🛑 [Queue] Daily download limit reached (${dailyCount}/${MAX_DOWNLOADS_PER_DAY}). Stopping queue.`);
      break;
    }

    // Get next pending book, excluding any we already skipped due to rate limits
    let job;
    if (skippedBookIds.length === 0) {
      job = stmts.getNextPending.get(MAX_ATTEMPTS);
    } else {
      const placeholders = skippedBookIds.map(() => '?').join(',');
      job = db.prepare(
        `SELECT * FROM books WHERE status = 'pending' AND attempts < ? AND id NOT IN (${placeholders}) ORDER BY attempts ASC LIMIT 1`
      ).get(MAX_ATTEMPTS, ...skippedBookIds);
    }

    if (!job) {
      break;
    }

    // Check per-user daily limits: only proceed if at least one linked user has quota left
    const linkedUsers = stmts.getUsersForBook.all(job.id);
    const eligibleUsers = linkedUsers.filter(u => !rateLimitedUserIds.has(u.id));

    if (eligibleUsers.length === 0) {
      skippedBookIds.push(job.id);
      skippedLimit++;
      continue;
    }

    // Build search query: strip series info like "(Culture, #3)" - it's noise for search
    const cleanTitle = (job.title || '').replace(/\(.*?\)/g, '').trim();
    const searchTerm = [cleanTitle, job.author].filter(Boolean).join(' ').trim();
    log(`📖 [Queue] Processing: "${job.title}" by ${job.author || '?'} (search: "${searchTerm}", attempt ${job.attempts + 1}/${MAX_ATTEMPTS}, book_id: ${job.id})`);

    const jobStart = Date.now();

    try {
      // Increment attempts immediately so we don't loop on crash
      stmts.incrementAttempts.run(job.id);

      if (!searchTerm) {
        throw new Error('No title or author available to search');
      }

      // 1. SEARCH Anna's Archive (fuzzy match against title + author)
      const downloadUrl = await findBookOnAnna(searchTerm, job.title, job.author);

      if (!downloadUrl) {
        throw new Error('Book not found on Anna\'s Archive');
      }

      // 2. DOWNLOAD the file
      log(`⬇️  [Queue] Downloading from: ${downloadUrl}`);
      const { filePath: tempPath, extension } = await downloadBook(downloadUrl, job);

      // 3. COPY to eligible users' download folders (skip users at their daily limit)
      const safeTitle = sanitizeFilename(`${job.author || 'Unknown'} - ${job.title || 'Unknown'}`);
      const filename = `${safeTitle}${extension}`;
      log(`📂 [Queue] Copying "${filename}" to ${eligibleUsers.length} user folder(s)...`);

      for (const user of eligibleUsers) {
        const destDir = user.download_path;
        const destPath = join(destDir, filename);

        mkdirSync(destDir, { recursive: true });
        fixOwnership(destDir);
        copyFileSync(tempPath, destPath);
        fixOwnership(destPath);
        log(`💾 [Queue] Saved: ${destPath} (for ${user.name})`);
      }

      // Clean up temp file
      try {
        unlinkSync(tempPath);
      } catch (cleanupErr) {
        logWarn(`[Queue] Could not delete temp file ${tempPath}: ${cleanupErr.message}`);
      }

      // 4. Mark as downloaded
      stmts.markDownloaded.run(filename, job.id);
      const elapsed = ((Date.now() - jobStart) / 1000).toFixed(1);
      log(`✅ [Queue] SUCCESS: "${job.title}" by ${job.author || '?'} (${elapsed}s)`);
      succeeded++;

      // Track this download for each user who received it (for email notifications)
      for (const user of eligibleUsers) {
        if (!downloadedPerUser.has(user.id)) {
          downloadedPerUser.set(user.id, { user, books: [] });
        }
        downloadedPerUser.get(user.id).books.push({ title: job.title, author: job.author });
      }

      // Refresh per-user limits — a user may have just hit their cap
      for (const user of eligibleUsers) {
        if (!rateLimitedUserIds.has(user.id)) {
          const userCount = stmts.countUserDownloadsToday.get(user.id).cnt;
          if (userCount >= MAX_DOWNLOADS_PER_USER_PER_DAY) {
            rateLimitedUserIds.add(user.id);
            log(`🛑 [Queue] User "${user.name}" has now reached their daily limit (${userCount}/${MAX_DOWNLOADS_PER_USER_PER_DAY}).`);
          }
        }
      }

    } catch (err) {
      const elapsed = ((Date.now() - jobStart) / 1000).toFixed(1);
      logError(`[Queue] FAILED: "${job.title}" by ${job.author || '?'} (attempt ${job.attempts + 1}/${MAX_ATTEMPTS}, ${elapsed}s)`, err);

      // Mark as failed if we've exhausted attempts
      if (job.attempts + 1 >= MAX_ATTEMPTS) {
        logWarn(`[Queue] Permanently failed after ${MAX_ATTEMPTS} attempts: "${job.title}" by ${job.author || '?'}`);
        stmts.markFailed.run(job.id);
      } else {
        log(`🔁 [Queue] Will retry "${job.title}" on next run (${MAX_ATTEMPTS - job.attempts - 1} attempt(s) remaining)`);
      }
      failed++;
    }

    processed++;
    // Cooldown between items to avoid rate-limiting
    await sleep(QUEUE_COOLDOWN_MS);
  }

  if (processed === 0 && skippedLimit === 0) {
    log('😴 [Queue] Queue empty. Nothing to process.');
  } else {
    log(`📊 [Queue] Done: ${succeeded} succeeded, ${failed} failed, ${skippedLimit} skipped (rate limit)`);
  }

  return downloadedPerUser;
}

// --- FUZZY MATCHING ---

/**
 * Normalize a string for fuzzy comparison:
 * lowercase, strip parenthetical info (e.g. series), remove punctuation, collapse whitespace.
 */
function normalizeText(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/\(.*?\)/g, '')       // Remove parenthetical info like "(Culture, #3)"
    .replace(/:\s*a novel$/i, '')  // Strip common subtitle noise like ": A Novel"
    .replace(/[^\w\s]/g, '')       // Remove punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compute word-overlap similarity between two strings (0–1).
 * Returns the fraction of words from the shorter string that appear in the longer one.
 */
function wordOverlap(a, b) {
  const wordsA = new Set(normalizeText(a).split(' ').filter(Boolean));
  const wordsB = new Set(normalizeText(b).split(' ').filter(Boolean));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  const [smaller, larger] = wordsA.size <= wordsB.size ? [wordsA, wordsB] : [wordsB, wordsA];
  let matches = 0;
  for (const w of smaller) {
    if (larger.has(w)) matches++;
  }
  return matches / smaller.size;
}

/**
 * Check whether a search result (title + author from Anna's Archive) is a
 * sufficiently good match for the expected title + author from Goodreads.
 *
 * Title must have >= 70% word overlap; if we have an expected author, at least
 * one of their name-parts must appear in the result's author string.
 */
function isGoodMatch(expectedTitle, expectedAuthor, resultTitle, resultAuthor) {
  const titleScore = wordOverlap(expectedTitle, resultTitle);

  log(`    [Match] Title overlap: ${(titleScore * 100).toFixed(0)}% ("${normalizeText(expectedTitle)}" vs "${normalizeText(resultTitle)}")`);

  if (titleScore < 0.7) {
    log(`    [Match] Title score ${(titleScore * 100).toFixed(0)}% < 70% threshold -> reject`);
    return false;
  }

  // If we have an expected author, verify at least one significant name-part matches
  if (expectedAuthor) {
    const expectedParts = normalizeText(expectedAuthor).split(' ').filter(w => w.length > 2);
    const resultAuthorNorm = normalizeText(resultAuthor);
    const authorHit = expectedParts.some(part => resultAuthorNorm.includes(part));

    log(`    [Match] Author check: expected parts [${expectedParts.join(', ')}] vs result "${resultAuthorNorm}" -> ${authorHit ? 'hit' : 'miss'}`);

    if (!authorHit) return false;
  } else {
    log(`    [Match] No expected author to check, skipping author verification`);
  }

  return true;
}

// --- ANNA'S ARCHIVE SEARCH ---

const MAX_RESULTS_TO_CHECK = 5;

/**
 * Search Anna's Archive for a book by query string, then fuzzy-match the
 * top results against the expected title/author from Goodreads.
 *
 * @param {string} query   - The search query (usually "title author")
 * @param {string} expectedTitle  - The book title from Goodreads
 * @param {string} expectedAuthor - The author from Goodreads (may be empty)
 * @returns {string|null} A download URL, or null if not found
 */
async function findBookOnAnna(query, expectedTitle, expectedAuthor) {
  const searchParams = 'search?index=&page=1&sort=&ext=epub&lang=en&lang=fr&lang=nl&display=&q=';

  for (let i = 0; i < AA_DOMAINS.length; i++) {
    const domain = AA_DOMAINS[i];
    const searchUrl = `https://${domain}/${searchParams}${encodeURIComponent(query)}`;

    log(`🌐 [Search] Trying domain ${i + 1}/${AA_DOMAINS.length}: ${domain}`);
    log(`🔗 [Search] URL: ${searchUrl}`);

    try {
      log(`🛡️  [Search] Sending request via FlareSolverr...`);
      const searchStart = Date.now();

      const response = await axios.post(FLARESOLVERR_URL, {
        cmd: 'request.get',
        url: searchUrl,
        maxTimeout: 120000,
      }, {
        timeout: 150000, // Give FlareSolverr extra time beyond its own timeout
        validateStatus: () => true, // Don't throw on 4xx/5xx - we handle it ourselves
      });

      const searchElapsed = ((Date.now() - searchStart) / 1000).toFixed(1);

      if (response.status !== 200) {
        const body = typeof response.data === 'string' ? response.data.substring(0, 500) : JSON.stringify(response.data).substring(0, 500);
        logError(`[Search] FlareSolverr HTTP ${response.status} for ${domain} (${searchElapsed}s): ${body}`);
        continue;
      }

      if (response.data.status !== 'ok') {
        logError(`[Search] FlareSolverr returned status "${response.data.status}" for ${domain} (${searchElapsed}s). Message: ${response.data.message || 'none'}`);
        continue;
      }

      const html = response.data.solution.response;
      log(`🛡️  [Search] FlareSolverr responded OK (${searchElapsed}s, HTML: ${html.length} chars)`);

      const $ = load(html);

      // Check if the results container exists at all
      const container = $('div.js-aarecord-list-outer');
      if (container.length === 0) {
        logWarn(`[Search] Results container (div.js-aarecord-list-outer) not found on page - page structure may have changed`);
        continue;
      }

      // Results live inside div.js-aarecord-list-outer; each direct child div is one result
      const resultDivs = container.children('div');

      if (resultDivs.length === 0) {
        log(`🔍 [Search] No results found on ${domain} for: "${query}"`);
        continue;
      }

      const toCheck = Math.min(resultDivs.length, MAX_RESULTS_TO_CHECK);
      log(`🔍 [Search] Found ${resultDivs.length} result(s), checking top ${toCheck}...`);

      for (let r = 0; r < toCheck; r++) {
        const el = $(resultDivs[r]);

        // Title: the <a> with class js-vim-focus
        const resultTitle = el.find('a.js-vim-focus').first().text().trim();

        // Author: the <a> whose child span has the user-edit icon
        const authorLink = el.find('span[class*="icon-[mdi--user-edit]"]').closest('a');
        const resultAuthor = authorLink.text().trim();

        // MD5: first <a> with href starting with /md5/
        const md5Href = el.find('a[href^="/md5/"]').first().attr('href');

        if (!md5Href) {
          logWarn(`[Search] Result #${r + 1}: no MD5 link found, skipping`);
          continue;
        }

        const md5Match = md5Href.match(/\/md5\/([a-fA-F0-9]+)/);
        if (!md5Match) {
          logWarn(`[Search] Result #${r + 1}: could not parse MD5 from href "${md5Href}", skipping`);
          continue;
        }

        const md5 = md5Match[1];

        log(`  [Search] Result #${r + 1}/${toCheck}: "${resultTitle}" by ${resultAuthor || '?'} (md5: ${md5})`);

        if (isGoodMatch(expectedTitle, expectedAuthor, resultTitle, resultAuthor)) {
          log(`  ✅ [Search] -> MATCH on result #${r + 1}`);

          if (AA_API_KEY) {
            const url = `https://${domain}/fast_download/${md5}/0/0?key=${AA_API_KEY}`;
            log(`  [Search] Using fast_download API: ${url.replace(AA_API_KEY, '***')}`);
            return url;
          }

          const url = `https://${domain}/md5/${md5}`;
          log(`  [Search] No API key - returning detail page: ${url}`);
          return url;
        }

        log(`  ❎ [Search] -> No match on result #${r + 1}`);
      }

      log(`🔍 [Search] None of the top ${toCheck} results matched "${expectedTitle}" by ${expectedAuthor || '?'} on ${domain}`);

    } catch (err) {
      logError(`[Search] Failed on ${domain}`, err);
      if (err.code) log(`[Search] Error code: ${err.code}`);
      if (err.response) log(`[Search] HTTP status: ${err.response.status}`);
      continue;
    }
  }

  log(`🔍 [Search] Exhausted all ${AA_DOMAINS.length} domain(s) - book not found`);
  return null;
}

// --- DOWNLOAD ---

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser';

async function applyStealthPatches(page) {
  await page.evaluateOnNewDocument(() => {
    /* eslint-disable no-undef -- runs in browser context via Puppeteer */
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
    const origQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = (params) =>
      params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery(params);
    /* eslint-enable no-undef */
  });
  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
}

async function waitForCloudflare(page, timeoutMs = 60000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const title = await page.title().catch(() => '');
    if (title.includes('Just a moment') || title.includes('Checking') || title.includes('Attention Required')) {
      log('🌐 [BrowserDL] Cloudflare challenge detected, waiting...');
      await sleep(3000);
      continue;
    }
    // Real page loaded — challenge is solved (or was never shown)
    return;
  }
  throw new Error('Cloudflare challenge did not resolve within timeout');
}

async function downloadWithBrowser(url, downloadDir, timeoutMs = 300000) {
  log('🌐 [BrowserDL] Launching Chromium...');
  const browser = await launch({
    executablePath: CHROMIUM_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--disable-blink-features=AutomationControlled',
    ],
    headless: 'new',
  });

  try {
    const page = await browser.newPage();
    await applyStealthPatches(page);
    page.setDefaultTimeout(timeoutMs);

    // Step 1: Visit the site root to solve any Cloudflare challenge
    const urlObj = new URL(url);
    const baseUrl = `${urlObj.protocol}//${urlObj.host}/`;
    log(`🌐 [BrowserDL] Solving Cloudflare challenge at ${baseUrl}...`);
    await page.goto(baseUrl, { timeout: 120000, waitUntil: 'domcontentloaded' });
    await waitForCloudflare(page);

    log('🌐 [BrowserDL] Cloudflare passed');

    // Step 2: Log into Anna's Archive using the API key (which is the AA "secret key")
    if (!AA_API_KEY) throw new Error('AA_API_KEY is not set — cannot log in to Anna\'s Archive');

    log('🌐 [BrowserDL] Logging into Anna\'s Archive...');
    await page.goto(`${baseUrl}account`, { timeout: 60000, waitUntil: 'domcontentloaded' });
    await waitForCloudflare(page);

    await page.waitForSelector('input[name="key"]', { timeout: 15000 });
    await page.type('input[name="key"]', AA_API_KEY, { delay: 30 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      page.$eval('input[name="key"]', el => el.closest('form').querySelector('button[type="submit"]').click()),
    ]);

    const postLoginUrl = page.url();
    if (postLoginUrl.includes('/account')) {
      log('🌐 [BrowserDL] Logged in successfully');
    } else {
      logWarn(`[BrowserDL] Login may have failed — landed on: ${postLoginUrl}`);
    }

    // Step 3: Navigate to the download URL. The server redirects to a CDN on a
    // different domain, so fetch() fails (CORS). Browser navigation handles
    // cross-origin redirects natively and triggers Chrome's download behavior.
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
    });

    const filesBefore = new Set(readdirSync(downloadDir));

    log('🌐 [BrowserDL] Navigating to download URL...');
    page.goto(url, { timeout: timeoutMs, waitUntil: 'load' }).catch(() => {});

    const dlStart = Date.now();
    let downloadedPath = null;

    while (Date.now() - dlStart < timeoutMs) {
      await sleep(3000);

      const filesNow = readdirSync(downloadDir);
      const newFiles = filesNow.filter(f => !filesBefore.has(f));
      const inProgress = newFiles.filter(f => f.endsWith('.crdownload'));
      const completed = newFiles.filter(f => !f.endsWith('.crdownload'));

      if (completed.length > 0) {
        const candidate = join(downloadDir, completed[0]);
        const size1 = statSync(candidate).size;
        await sleep(2000);
        const size2 = statSync(candidate).size;
        if (size1 === size2 && size1 > 0) {
          downloadedPath = candidate;
          break;
        }
      }

      if (inProgress.length > 0) {
        const crPath = join(downloadDir, inProgress[0]);
        const crSize = statSync(crPath).size;
        log(`🌐 [BrowserDL] Downloading... ${(crSize / 1024 / 1024).toFixed(1)} MB so far`);
        continue;
      }

      if (Date.now() - dlStart > 90000) {
        const currentUrl = page.url();
        const title = await page.title().catch(() => '');
        const bodyText = await page.evaluate(() =>
          // eslint-disable-next-line no-undef -- runs in browser context via Puppeteer
          (document.body?.innerText || '').replace(/\s+/g, ' ').trim().substring(0, 500)
        ).catch(() => '');
        throw new Error(
          `No download started after 90s. URL: ${currentUrl}, Title: "${title}". Content: ${bodyText}`
        );
      }
    }

    if (!downloadedPath) {
      throw new Error('Browser download timed out');
    }

    const size = statSync(downloadedPath).size;
    log(`🌐 [BrowserDL] Complete: ${basename(downloadedPath)} (${(size / 1024 / 1024).toFixed(2)} MB)`);
    return downloadedPath;
  } finally {
    await browser.close();
    log('🌐 [BrowserDL] Browser closed');
  }
}

async function downloadBook(url, job) {
  const tempDir = join(dirname(DB_PATH), 'tmp');
  mkdirSync(tempDir, { recursive: true });

  const safeTitle = sanitizeFilename(`${job.author || 'Unknown'} - ${job.title || 'Unknown'}`);

  if (url.includes('/fast_download/')) {
    // Cloudflare's cf_clearance cookie is bound to the TLS fingerprint (JA3) of the
    // solving client. Node.js has a completely different JA3 than Chrome, so passing
    // FlareSolverr cookies to axios always results in a 403. Use a real browser instead.
    log('🌐 [Download] Using browser download for fast_download URL...');
    const dlStart = Date.now();

    const downloadedPath = await downloadWithBrowser(url, tempDir);

    const stats = statSync(downloadedPath);
    const dlElapsed = ((Date.now() - dlStart) / 1000).toFixed(1);
    log(`⬇️  [Download] Completed: ${(stats.size / 1024 / 1024).toFixed(2)} MB in ${dlElapsed}s`);

    if (stats.size < 1024) {
      const content = readFileSync(downloadedPath, 'utf-8');
      unlinkSync(downloadedPath);
      throw new Error(`Downloaded file too small (${stats.size} bytes), likely an error page: ${content.substring(0, 300)}`);
    }

    const extension = extname(downloadedPath).toLowerCase() || '.epub';
    const tempPath = join(tempDir, `${safeTitle}${extension}`);
    if (downloadedPath !== tempPath) {
      if (existsSync(tempPath)) unlinkSync(tempPath);
      renameSync(downloadedPath, tempPath);
    }

    return { filePath: tempPath, extension };
  }

  // Non-fast_download URLs: stream download with axios
  log(`⬇️  [Download] Starting stream download (5 min timeout)...`);
  const dlStart = Date.now();

  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 300000,
    maxRedirects: 10,
  });

  const contentType = response.headers['content-type'] || 'unknown';
  const contentLength = response.headers['content-length'] || 'unknown';
  const disposition = response.headers['content-disposition'] || 'none';
  log(`[Download] Response: status=${response.status}, content-type=${contentType}, content-length=${contentLength}, content-disposition=${disposition}`);

  const extension = getFileExtension(response);
  log(`[Download] Determined file extension: ${extension}`);

  const tempPath = join(tempDir, `${safeTitle}${extension}`);

  const writer = createWriteStream(tempPath);
  await pipeline(response.data, writer);

  const stats = statSync(tempPath);
  const dlElapsed = ((Date.now() - dlStart) / 1000).toFixed(1);
  log(`⬇️  [Download] Completed: ${(stats.size / 1024 / 1024).toFixed(2)} MB in ${dlElapsed}s -> ${tempPath}`);

  if (stats.size < 1024) {
    const content = readFileSync(tempPath, 'utf-8');
    unlinkSync(tempPath);
    throw new Error(`Downloaded file too small (${stats.size} bytes), likely an error page: ${content.substring(0, 300)}`);
  }

  return { filePath: tempPath, extension };
}

function getFileExtension(response) {
  // Try Content-Disposition header first
  const disposition = response.headers['content-disposition'];
  if (disposition) {
    const filenameMatch = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    if (filenameMatch) {
      const filename = filenameMatch[1].replace(/['"]/g, '');
      const ext = extname(filename);
      if (ext) return ext;
    }
  }

  // Try Content-Type header
  const contentType = response.headers['content-type'];
  const typeMap = {
    'application/epub+zip': '.epub',
    'application/epub': '.epub',
    'application/pdf': '.pdf',
    'application/x-mobipocket-ebook': '.mobi',
    'application/vnd.amazon.ebook': '.azw3',
    'application/x-cbz': '.cbz',
    'application/x-cbr': '.cbr',
    'application/zip': '.zip',
  };

  if (contentType) {
    for (const [type, ext] of Object.entries(typeMap)) {
      if (contentType.includes(type)) return ext;
    }
  }

  // Try the URL path
  try {
    const urlPath = new URL(response.config.url || response.request.path).pathname;
    const ext = extname(urlPath);
    if (ext && ext.length <= 6) return ext;
  } catch (e) { /* ignore */
    void e;
  }

  // Default to epub
  return '.epub';
}

// --- RUN CYCLE ---

let cycleRunning = false;

async function runCycle(trigger) {
  if (cycleRunning) {
    logWarn(`Cycle already running, ignoring trigger: ${trigger}`);
    return;
  }

  cycleRunning = true;
  const cycleStart = Date.now();
  log(`\n🚀 ========== CYCLE START (trigger: ${trigger}) ==========`);

  try {
    await syncRSS();
    const downloadedPerUser = await processQueue();

    // Send email notifications to users who had books downloaded this cycle
    if (downloadedPerUser && downloadedPerUser.size > 0) {
      log(`📧 [Email] Sending notifications to ${downloadedPerUser.size} user(s)...`);
      for (const { user, books } of downloadedPerUser.values()) {
        await sendDownloadNotification(user, books);
      }
    }
  } catch (err) {
    logError(`Cycle failed (trigger: ${trigger})`, err);
  }

  const cycleElapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
  log(`🏁 ========== CYCLE END (${cycleElapsed}s) ==========`);
  cycleRunning = false;
}

// --- INIT ---
initDb();
log('🚀 === goodreads-sync service starting ===');
log(`  📁 DB_PATH:        ${DB_PATH}`);
log(`  ⏰ CRON_SCHEDULE:  ${CRON_SCHEDULE}`);
log(`  🛡️ FLARESOLVERR:   ${FLARESOLVERR_URL}`);
log(`  🌐 AA_DOMAINS:     ${AA_DOMAINS.join(', ')}`);
log(`  🔑 AA_API_KEY:     ${AA_API_KEY ? `***${  AA_API_KEY.slice(-4)}` : 'NOT SET'}`);
log(`  🔁 MAX_ATTEMPTS:   ${MAX_ATTEMPTS}`);
log(`  ⏱️ COOLDOWN:       ${QUEUE_COOLDOWN_MS}ms`);
log(`  📊 DAILY_LIMIT:    ${MAX_DOWNLOADS_PER_DAY} overall, ${MAX_DOWNLOADS_PER_USER_PER_DAY} per user`);
log(`  📧 SMTP:           ${SMTP_FROM ? `${SMTP_HOST}:${SMTP_PORT} (from: ${SMTP_FROM})` : 'NOT CONFIGURED'}`);
log(`  👥 USERS:          ${stmts.getUsers.all().map(u => u.name).join(', ')}`);

if (!AA_API_KEY) {
  logWarn('⚠️ AA_API_KEY not set. Downloads will not work via fast_download API.');
}

// Manual trigger: send SIGUSR1 to kick off a cycle
// Usage: docker kill --signal=SIGUSR1 book-sync
process.on('SIGUSR1', () => {
  log('👆 Received SIGUSR1 - triggering manual cycle');
  runCycle('manual');
});

async function waitForFlareSolverr(maxRetries = 30, intervalMs = 5000) {
  log(`⏳ Waiting for FlareSolverr at ${FLARESOLVERR_URL}...`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await axios.get(FLARESOLVERR_URL.replace('/v1', '/health'), {
        timeout: 5000,
        validateStatus: () => true,
      });
      log(`✅ FlareSolverr is ready (attempt ${attempt}, status: ${res.status})`);
      return;
    } catch (err) {
      log(`⏳ FlareSolverr not ready yet (attempt ${attempt}/${maxRetries}): ${err.code || err.message}`);
      if (attempt < maxRetries) await sleep(intervalMs);
    }
  }

  logWarn(`⚠️ FlareSolverr did not become ready after ${maxRetries} attempts - proceeding anyway`);
}

(async () => {
  await sleep(5000); // delayed startup
  await waitForFlareSolverr();
  await runCycle('startup');
})();

schedule(CRON_SCHEDULE, async () => {
  await runCycle('cron');
});
