const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || '/app/data/books.db';

try {
  const db = new Database(DB_PATH);

  const users = db.prepare('SELECT * FROM users ORDER BY name').all();

  if (users.length === 0) {
    console.log('No users found.');
    db.close();
    process.exit(0);
  }

  console.log(`Found ${users.length} user(s):\n`);

  for (const user of users) {
    console.log(`👤 Name:          ${user.name}`);
    console.log(`🔗 Goodreads ID:  ${user.goodreads_id}`);
    console.log(`📂 Path:          ${user.download_path}`);
    console.log(`📧 Email:         ${user.email || '(none)'}`);
    console.log(`🆔 ID:            ${user.id}`);
    console.log('');
  }

  db.close();
} catch (err) {
  console.error('❌ Database error:', err.message);
  process.exit(1);
}
