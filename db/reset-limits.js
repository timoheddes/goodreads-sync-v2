import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || '/app/data/books.db';

try {
  const db = new Database(DB_PATH);

  const result = db.prepare(`
    UPDATE books SET downloaded_at = date('now', '-1 day')
    WHERE status = 'downloaded' AND date(downloaded_at) = date('now')
  `).run();

  console.log(`✅ Reset ${result.changes} download timestamp(s) to yesterday. Limits are now clear.`);

  db.close();
} catch (err) {
  console.error('❌ Database error:', err.message);
  process.exit(1);
}
