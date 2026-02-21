import { log } from './logging.js';
import { DB_PATH } from './config.js';
import Database from 'better-sqlite3';

export let db = null;
export let stmts = {};

export function initDb() {
  log(`🗄️  Initialising database at: ${DB_PATH}`);
  db = new Database(DB_PATH);
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
    void e;
  }

  // Migrate: add email column to users table
  try {
    db.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
    log('🗄️  Migration: added email column to users table');
  } catch (e) {
    void e;
  }

  // Migrate: add downloaded_at column (updated_at gets bumped by RSS upserts, so it's unreliable for rate limiting)
  try {
    db.exec(`ALTER TABLE books ADD COLUMN downloaded_at DATETIME`);
    db.exec(`UPDATE books SET downloaded_at = updated_at WHERE status = 'downloaded' AND downloaded_at IS NULL`);
    log('🗄️  Migration: added downloaded_at column to books table');
  } catch (e) {
    void e;
  }

  // Prepare statements after DB and schema are ready
  stmts = {
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
    markDownloaded: db.prepare(`UPDATE books SET status = 'downloaded', file_path = ?, downloaded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`),
    markFailed: db.prepare(`UPDATE books SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`),
    countDownloadsToday: db.prepare(`
      SELECT COUNT(*) as cnt FROM books
      WHERE status = 'downloaded' AND date(downloaded_at) = date('now')
    `),
    countUserDownloadsToday: db.prepare(`
      SELECT COUNT(*) as cnt FROM books
      JOIN user_books ON books.id = user_books.book_id
      WHERE books.status = 'downloaded' AND date(books.downloaded_at) = date('now')
      AND user_books.user_id = ?
    `),
    getUsersForBook: db.prepare(`
      SELECT users.id, users.name, users.download_path, users.email
      FROM users
      JOIN user_books ON users.id = user_books.user_id
      WHERE user_books.book_id = ?
    `),
  };
}