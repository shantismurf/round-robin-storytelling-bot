/**
 * database-setup.js
 * Initialises the database schema on a fresh install, then applies any
 * pending migrations from db/migrations/ in filename order.
 *
 * Every migration file is a plain SQL script. The migrations table records
 * which files have been applied; each file runs exactly once.
 */

import fs from 'fs';
import path from 'path';
import { DB, log } from './utilities.js';

const MIGRATIONS_DIR = './db/migrations';

async function ensureMigrationsTable(connection) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS migrations (
      migration_id INT AUTO_INCREMENT PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getAppliedMigrations(connection) {
  const [rows] = await connection.execute(`SELECT filename FROM migrations ORDER BY filename`);
  return new Set(rows.map(r => r.filename));
}

async function runMigrationFile(connection, filepath, filename) {
  const sql = fs.readFileSync(filepath, 'utf8');

  // Split on semicolons, skip blank and comment-only statements
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.replace(/--[^\n]*/g, '').trim().length > 0);

  for (const statement of statements) {
    await connection.execute(statement);
  }

  await connection.execute(
    `INSERT INTO migrations (filename) VALUES (?)`,
    [filename]
  );
}

async function stampLegacyMigrations(connection) {
  // If this is an existing database that pre-dates the migration system,
  // detect the presence of the most recently added legacy column and stamp
  // all legacy migrations as applied so they aren't re-run.
  const [rows] = await connection.execute(`SELECT filename FROM migrations LIMIT 1`);
  if (rows.length > 0) return; // migrations table already has entries — nothing to do

  const [tagTable] = await connection.execute(`SHOW TABLES LIKE 'story_tag_submission'`);
  if (tagTable.length === 0) return; // fresh install — let migrations run normally

  log('Migrations: stamping legacy migrations 001–007 as already applied.', { show: true });
  const legacy = [
    '001_guild_story_id.sql',
    '002_job_turn_id.sql',
    '003_story_entry_deleted_status.sql',
    '004_turn_more_time_requested.sql',
    '005_story_entry_edit_table.sql',
    '006_story_ao3_metadata.sql',
    '007_story_tag_submission_table.sql',
  ];
  for (const filename of legacy) {
    await connection.execute(
      `INSERT IGNORE INTO migrations (filename) VALUES (?)`,
      [filename]
    );
  }
}

export async function dbSetup(connection) {
  await ensureMigrationsTable(connection);
  await stampLegacyMigrations(connection);

  const applied = await getAppliedMigrations(connection);

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    log('No migrations directory found — skipping migrations.', { show: true });
    return;
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const pending = files.filter(f => !applied.has(f));

  if (pending.length === 0) {
    log('Migrations: all up to date.', { show: true });
    return;
  }

  log(`Migrations: ${pending.length} pending.`, { show: true });
  for (const filename of pending) {
    const filepath = path.join(MIGRATIONS_DIR, filename);
    log(`Migration: applying ${filename}...`, { show: true });
    try {
      await runMigrationFile(connection, filepath, filename);
      log(`Migration: ${filename} applied.`, { show: true });
    } catch (err) {
      log(`Migration: ${filename} FAILED: ${err}`, { show: true });
      throw err;
    }
  }
}

export async function setupDatabase(config) {
  log('Starting database setup...', { show: true });

  try {
    const db = new DB(config.db);
    await db.connect();
    log('Database connection successful', { show: true });

    // Create schema if this is a fresh database
    const [tables] = await db.connection.execute("SHOW TABLES LIKE 'story'");
    if (tables.length === 0) {
      log('Creating database schema...', { show: true });
      const schemaSQL = fs.readFileSync('db/init.sql', 'utf8');
      const statements = schemaSQL.split(';').filter(stmt => stmt.trim().length > 0);
      for (const statement of statements) {
        await db.connection.execute(statement);
      }
      log('Database schema created successfully', { show: true });
    } else {
      log('Database schema already exists', { show: true });
    }

    await dbSetup(db.connection);

    await db.disconnect();
    log('Database setup completed successfully', { show: true });
    return true;

  } catch (error) {
    log(`Database setup failed: ${error}`, { show: true });
    return false;
  }
}
