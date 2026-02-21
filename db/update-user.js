import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || '/app/data/books.db';

const args = process.argv.slice(2);
const goodreadsId = args[0];

if (!goodreadsId) {
  console.error('❌ Error: Missing Goodreads ID.');
  console.log('\nUsage: node db/update-user.js "<Goodreads_ID>" --field value');
  console.log('\nSupported fields:');
  console.log('  --name "<Name>"');
  console.log('  --email "<Email>"');
  console.log('  --path "<Download_Path>"');
  console.log('\nExamples:');
  console.log('  node db/update-user.js "104614681" --email "alice@example.com"');
  console.log('  node db/update-user.js "104614681" --name "Alice B" --email "alice@example.com"');
  console.log('  node db/update-user.js "104614681" --email ""   # clear email');
  process.exit(1);
}

const fields = {};
const remaining = args.slice(1);

for (let i = 0; i < remaining.length; i += 2) {
  const flag = remaining[i];
  const value = remaining[i + 1];

  if (value === undefined) {
    console.error(`❌ Error: Missing value for ${flag}`);
    process.exit(1);
  }

  switch (flag) {
    case '--name':
      fields.name = value;
      break;
    case '--email':
      fields.email = value || null;
      break;
    case '--path':
      fields.download_path = value;
      break;
    default:
      console.error(`❌ Error: Unknown flag "${flag}"`);
      process.exit(1);
  }
}

if (Object.keys(fields).length === 0) {
  console.error('❌ Error: No fields to update. Use --name, --email, or --path.');
  process.exit(1);
}

try {
  const db = new Database(DB_PATH);

  const user = db.prepare('SELECT * FROM users WHERE goodreads_id = ?').get(goodreadsId);
  if (!user) {
    console.error(`❌ Error: No user found with Goodreads ID "${goodreadsId}".`);
    process.exit(1);
  }

  const setClauses = [];
  const values = [];
  for (const [col, val] of Object.entries(fields)) {
    setClauses.push(`${col} = ?`);
    values.push(val);
  }
  values.push(goodreadsId);

  const sql = `UPDATE users SET ${setClauses.join(', ')} WHERE goodreads_id = ?`;
  db.prepare(sql).run(...values);

  const updated = db.prepare('SELECT * FROM users WHERE goodreads_id = ?').get(goodreadsId);

  console.log(`✅ User updated successfully.`);
  console.log(`👤 Name:          ${updated.name}`);
  console.log(`🔗 Goodreads ID:  ${updated.goodreads_id}`);
  console.log(`📂 Path:          ${updated.download_path}`);
  console.log(`📧 Email:         ${updated.email || '(none)'}`);
  console.log(`🆔 ID:            ${updated.id}`);

  db.close();
} catch (err) {
  console.error('❌ Database error:', err.message);
  process.exit(1);
}
