import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || '/app/data/books.db';

const [name, goodreadsId, downloadPath, email] = process.argv.slice(2);

if (!name || !goodreadsId || !downloadPath) {
  console.error('❌ Error: Missing arguments.');
  console.log('\nUsage: node db/add-user.js "<Name>" "<Goodreads_ID>" "<Download_Path>" ["<Email>"]');
  console.log('Example: node db/add-user.js "Alice" "104614681" "/downloads/Alice" "alice@example.com"');
  process.exit(1);
}

try {
  const db = new Database(DB_PATH);

  const insert = db.prepare(`
    INSERT INTO users (name, goodreads_id, download_path, email)
    VALUES (?, ?, ?, ?)
  `);

  const info = insert.run(name, goodreadsId, downloadPath, email || null);

  console.log(`✅ Success! User added to database.`);
  console.log(`👤 Name: ${name}`);
  console.log(`🔗 Goodreads ID:  ${goodreadsId}`);
  console.log(`📂 Path: ${downloadPath}`);
  console.log(`📧 Email: ${email || '(none)'}`);
  console.log(`🆔 ID:   ${info.lastInsertRowid}`);

  db.close();
} catch (err) {
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    console.error('❌ Error: A user with this Goodreads ID already exists in the database.');
  } else {
    console.error('❌ Database error:', err.message);
  }
  process.exit(1);
}
