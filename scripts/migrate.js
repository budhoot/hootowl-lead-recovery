require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

async function migrate() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be configured before running migrations.');
  }

  const directory = path.join(__dirname, '..', 'db', 'migrations');
  const migrations = fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7139021)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)');
    for (const name of migrations) {
      const applied = await client.query('SELECT name FROM schema_migrations WHERE name=$1', [name]);
      if (!applied.rowCount) {
        await client.query(fs.readFileSync(path.join(directory, name), 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
      }
    }
    await client.query('COMMIT');
    console.log('Database migration completed.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

migrate().catch((error) => {
  console.error('Database migration failed:', error);
  process.exitCode = 1;
});
