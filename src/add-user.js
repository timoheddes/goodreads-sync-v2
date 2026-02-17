const Database = require('better-sqlite3');
const path = require('path');

// Target the same DB file as your main app. 
// If running inside Docker, it will use /app/data/books.db
const DB_PATH = process.env.DB_PATH || '/app/data/books.db';

// Grab arguments passed via CLI
const [name, goodreadsId, downloadPath, email] = process.argv.slice(2);

// Basic validation
if (!name || !goodreadsId || !downloadPath) {
  console.error('❌ Error: Missing arguments.');
  console.log('\nUsage: node src/add-user.js "<Name>" "<Goodreads_ID>" "<Download_Path>" ["<Email>"]');
  console.log('Example: node src/add-user.js "Alice" "104614681" "/downloads/Alice" "alice@example.com"');
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
  
} catch (err) {
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    console.error('❌ Error: A user with this Goodreads ID already exists in the database.');
  } else {
    console.error('❌ Database error:', err.message);
  }
  process.exit(1);
}