const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || '/app/data/books.db';
const flag = process.argv[2];
const validFlags = ['--confirm', '--all'];

if (!validFlags.includes(flag)) {
  console.log('⚠️  This will delete all books, user-book links, and download history.');
  console.log('   Users are kept by default so you don\'t have to re-add them.');
  console.log('   On the next sync cycle, all "to-read" books will be re-queued as pending.\n');
  console.log('Usage:');
  console.log('  node src/reset-db.js --confirm        Reset books only (keep users)');
  console.log('  node src/reset-db.js --all            Reset everything (books + users)');
  process.exit(1);
}

const resetUsers = flag === '--all';

try {
  const db = new Database(DB_PATH);

  const bookCount = db.prepare('SELECT COUNT(*) as cnt FROM books').get().cnt;
  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;

  db.exec('DELETE FROM user_books');
  db.exec('DELETE FROM books');
  console.log(`🗑️  Deleted ${bookCount} book(s) and all user-book links.`);

  if (resetUsers) {
    db.exec('DELETE FROM users');
    console.log(`🗑️  Deleted ${userCount} user(s).`);
  } else {
    console.log(`👤 Kept ${userCount} user(s).`);
  }

  console.log('✅ Database reset complete. Next sync cycle will re-discover all to-read books.');

  db.close();
} catch (err) {
  console.error('❌ Database error:', err.message);
  process.exit(1);
}
