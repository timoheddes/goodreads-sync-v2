const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const Parser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');

// --- CONFIG ---
const DB_PATH = process.env.DB_PATH || '/app/data/books.db';
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 * * * *';
const AA_API_KEY = process.env.AA_API_KEY;
const FLARESOLVERR_URL = process.env.FLARE_URL || 'http://flaresolverr:8191/v1';
const MAX_ATTEMPTS = 5;
const QUEUE_COOLDOWN_MS = 5000; // 5 seconds between queue items
const MAX_DOWNLOADS_PER_USER_PER_DAY = 10;
const MAX_DOWNLOADS_PER_DAY = 50;
const SMTP_HOST = process.env.SMTP_HOST || 'localhost';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '25', 10);
const SMTP_FROM = process.env.SMTP_FROM || '';

const AA_DOMAINS = [
  'annas-archive.li',
  'annas-archive.gl',
];

// --- LOGGING ---
function timestamp() {
  // Use TZ env var (e.g. Europe/Amsterdam) for local time; falls back to UTC
  return new Date().toLocaleString('sv-SE', {
    timeZone: process.env.TZ || 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

function logError(msg, err) {
  console.error(`[${timestamp()}] ❌ ${msg}`, err ? err.message : '');
  if (err && err.stack) {
    console.error(err.stack);
  }
}

function logWarn(msg) {
  console.warn(`[${timestamp()}] ⚠️  ${msg}`);
}

// --- DATABASE SETUP ---
log(`🗄️  Initialising database at: ${DB_PATH}`);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
log('🗄️  Database connected (WAL mode)');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    goodreads_id TEXT NOT NULL UNIQUE,
    download_path TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goodreads_book_id TEXT UNIQUE,
    isbn TEXT,
    title TEXT,
    author TEXT,
    status TEXT DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    file_path TEXT,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_books (
    user_id INTEGER,
    book_id INTEGER,
    is_notified INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, book_id),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(book_id) REFERENCES books(id)
  );
`);

// Migrate: add goodreads_book_id column if it doesn't exist (for existing DBs)
try {
  db.exec(`ALTER TABLE books ADD COLUMN goodreads_book_id TEXT UNIQUE`);
  log('🗄️  Migration: added goodreads_book_id column to books table');
} catch (e) {
  // Column already exists, ignore
}

// Migrate: add email column to users table
try {
  db.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
  log('🗄️  Migration: added email column to users table');
} catch (e) {
  // Column already exists, ignore
}

// --- PREPARED STATEMENTS ---
const stmts = {
  getUsers: db.prepare('SELECT * FROM users'),
  upsertBookByGoodreadsId: db.prepare(`
    INSERT INTO books (goodreads_book_id, isbn, title, author)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(goodreads_book_id) DO UPDATE SET
      isbn = COALESCE(excluded.isbn, books.isbn),
      title = COALESCE(excluded.title, books.title),
      author = COALESCE(excluded.author, books.author),
      updated_at = CURRENT_TIMESTAMP
  `),
  getBookByGoodreadsId: db.prepare('SELECT id FROM books WHERE goodreads_book_id = ?'),
  linkUserBook: db.prepare('INSERT OR IGNORE INTO user_books (user_id, book_id) VALUES (?, ?)'),
  getNextPending: db.prepare(`
    SELECT * FROM books
    WHERE status = 'pending'
    AND attempts < ?
    ORDER BY attempts ASC
    LIMIT 1
  `),
  getUserPathsForBook: db.prepare(`
    SELECT users.download_path
    FROM users
    JOIN user_books ON users.id = user_books.user_id
    WHERE user_books.book_id = ?
  `),
  incrementAttempts: db.prepare('UPDATE books SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?'),
  markDownloaded: db.prepare(`UPDATE books SET status = 'downloaded', file_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`),
  markFailed: db.prepare(`UPDATE books SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`),

  // Daily download counts (using UTC dates since SQLite CURRENT_TIMESTAMP is UTC)
  countDownloadsToday: db.prepare(`
    SELECT COUNT(*) as cnt FROM books
    WHERE status = 'downloaded' AND date(updated_at) = date('now')
  `),
  countUserDownloadsToday: db.prepare(`
    SELECT COUNT(*) as cnt FROM books
    JOIN user_books ON books.id = user_books.book_id
    WHERE books.status = 'downloaded' AND date(books.updated_at) = date('now')
    AND user_books.user_id = ?
  `),
  getUsersForBook: db.prepare(`
    SELECT users.id, users.name, users.download_path, users.email
    FROM users
    JOIN user_books ON users.id = user_books.user_id
    WHERE user_books.book_id = ?
  `),
};

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
        const destPath = path.join(destDir, filename);

        // Ensure the destination directory exists
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(tempPath, destPath);
        log(`💾 [Queue] Saved: ${destPath} (for ${user.name})`);
      }

      // Clean up temp file
      try {
        fs.unlinkSync(tempPath);
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

      const $ = cheerio.load(html);

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

async function downloadBook(url, job) {
  const tempDir = path.join(path.dirname(DB_PATH), 'tmp');
  fs.mkdirSync(tempDir, { recursive: true });

  // If using the fast_download API, it returns JSON with a download link
  // We need to follow it to get the actual file
  let finalUrl = url;

  if (url.includes('/fast_download/')) {
    log('🛡️  [Download] Resolving fast_download page via FlareSolverr...');

    const flareResponse = await axios.post(FLARESOLVERR_URL, {
      cmd: 'request.get',
      url: url,
      maxTimeout: 120000,
    }, {
      timeout: 150000,
      validateStatus: () => true,
    });

    if (flareResponse.status !== 200 || !flareResponse.data || flareResponse.data.status !== 'ok') {
      const msg = flareResponse.data?.message || flareResponse.data?.status || `HTTP ${flareResponse.status}`;
      throw new Error(`FlareSolverr failed to resolve fast_download page: ${msg}`);
    }

    const html = flareResponse.data.solution.response;
    const resolvedUrl = flareResponse.data.solution.url;
    log(`🛡️  [Download] FlareSolverr resolved page (final URL: ${resolvedUrl}, HTML: ${html.length} chars)`);

    // Parse the fast_download page for the actual download link
    const $ = cheerio.load(html);

    // Look for direct download links (common patterns on AA fast_download pages)
    let downloadLink = null;

    // Check for a direct link containing /dl/ or known file CDN patterns
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (href && (href.includes('/dl/') || href.includes('cloudflare-ipfs') || href.includes('.epub') || href.includes('.pdf') || href.includes('download'))) {
        if (!downloadLink) {
          downloadLink = href;
        }
      }
    });

    if (downloadLink) {
      // Make absolute if relative
      if (downloadLink.startsWith('/')) {
        const urlObj = new URL(url);
        downloadLink = `${urlObj.protocol}//${urlObj.host}${downloadLink}`;
      }
      finalUrl = downloadLink;
      log(`🔗 [Download] Found download link in page: ${finalUrl}`);
    } else {
      // Log a snippet of the page for debugging
      const bodyText = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 500);
      logWarn(`[Download] Could not find download link in fast_download page. Page text: ${bodyText}`);
      throw new Error('Could not extract download link from fast_download page');
    }
  }

  // Stream download the actual file
  log(`⬇️  [Download] Starting stream download (5 min timeout)...`);
  const dlStart = Date.now();

  const response = await axios.get(finalUrl, {
    responseType: 'stream',
    timeout: 300000, // 5 min timeout for large files
    maxRedirects: 10,
  });

  // Log response headers for debugging
  const contentType = response.headers['content-type'] || 'unknown';
  const contentLength = response.headers['content-length'] || 'unknown';
  const disposition = response.headers['content-disposition'] || 'none';
  log(`[Download] Response: status=${response.status}, content-type=${contentType}, content-length=${contentLength}, content-disposition=${disposition}`);

  // Determine file extension from Content-Type or Content-Disposition
  const extension = getFileExtension(response);
  log(`[Download] Determined file extension: ${extension}`);

  const safeTitle = sanitizeFilename(`${job.author || 'Unknown'} - ${job.title || 'Unknown'}`);
  const tempPath = path.join(tempDir, `${safeTitle}${extension}`);

  // Stream to disk
  const writer = fs.createWriteStream(tempPath);
  await pipeline(response.data, writer);

  const stats = fs.statSync(tempPath);
  const dlElapsed = ((Date.now() - dlStart) / 1000).toFixed(1);
  log(`⬇️  [Download] Completed: ${(stats.size / 1024 / 1024).toFixed(2)} MB in ${dlElapsed}s -> ${tempPath}`);

  if (stats.size < 1024) {
    // File is suspiciously small (< 1KB), probably an error page
    const content = fs.readFileSync(tempPath, 'utf-8');
    fs.unlinkSync(tempPath);
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
      const ext = path.extname(filename);
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
    const ext = path.extname(urlPath);
    if (ext && ext.length <= 6) return ext;
  } catch (e) { /* ignore */ }

  // Default to epub
  return '.epub';
}

// --- UTILITIES ---

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '')  // Remove illegal chars
    .replace(/\s+/g, ' ')           // Collapse whitespace
    .trim()
    .substring(0, 200);             // Cap length
}

// --- EMAIL NOTIFICATIONS ---

const smtpTransport = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  tls: { rejectUnauthorized: false },
});

function buildEmailHtml(userName, books) {
  const bookRows = books.map(b => `
    <tr>
      <td style="padding: 12px 16px; border-bottom: 1px solid #f0f0f0;">
        <strong style="color: #1a1a1a;">${b.title || 'Unknown Title'}</strong>
        <br>
        <span style="color: #666; font-size: 14px;">${b.author || 'Unknown Author'}</span>
      </td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 32px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background-color: #2d3748; padding: 28px 32px; text-align: center;">
              <span style="font-size: 28px;">📚</span>
              <h1 style="color: #ffffff; margin: 8px 0 0; font-size: 20px; font-weight: 600;">New books ready!</h1>
            </td>
          </tr>
          <!-- Greeting -->
          <tr>
            <td style="padding: 28px 32px 16px;">
              <p style="color: #333; font-size: 16px; margin: 0;">
                Hi ${userName},
              </p>
              <p style="color: #555; font-size: 15px; margin: 12px 0 0;">
                ${books.length === 1 ? 'A new book was' : `${books.length} new books were`} downloaded and ${books.length === 1 ? 'is' : 'are'} ready for you to read.
              </p>
            </td>
          </tr>
          <!-- Book list -->
          <tr>
            <td style="padding: 0 32px 24px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #fafafa; border-radius: 8px; border: 1px solid #eee;">
                ${bookRows}
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding: 16px 32px 28px; text-align: center;">
              <p style="color: #999; font-size: 13px; margin: 0;">Happy reading!</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendDownloadNotification(user, books) {
  if (!user.email) return;
  if (!SMTP_FROM) {
    logWarn(`[Email] SMTP_FROM not configured — skipping email for ${user.name}`);
    return;
  }
  if (books.length === 0) return;

  const subject = books.length === 1
    ? `📚 "${books[0].title}" is ready to read`
    : `📚 ${books.length} new books are ready to read`;

  try {
    await smtpTransport.sendMail({
      from: SMTP_FROM,
      to: user.email,
      subject,
      html: buildEmailHtml(user.name, books),
    });
    log(`📧 [Email] Sent notification to ${user.name} (${user.email}): ${books.length} book(s)`);
  } catch (err) {
    logError(`[Email] Failed to send to ${user.name} (${user.email})`, err);
  }
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
log('🚀 === goodreads-sync service starting ===');
log(`  📁 DB_PATH:        ${DB_PATH}`);
log(`  ⏰ CRON_SCHEDULE:  ${CRON_SCHEDULE}`);
log(`  🛡️ FLARESOLVERR:   ${FLARESOLVERR_URL}`);
log(`  🌐 AA_DOMAINS:     ${AA_DOMAINS.join(', ')}`);
log(`  🔑 AA_API_KEY:     ${AA_API_KEY ? '***' + AA_API_KEY.slice(-4) : 'NOT SET'}`);
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

cron.schedule(CRON_SCHEDULE, async () => {
  await runCycle('cron');
});
