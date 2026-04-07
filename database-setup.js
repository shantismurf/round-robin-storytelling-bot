/**
 * Database setup utility for Round Robin StoryBot
 * This module provides functions to initialize the database schema and configuration
 */

import fs from 'fs';
import { DB, log } from './utilities.js';

/**
 * Setup database schema and configuration
 * @param {Object} config - Database configuration from config.json
 * @returns {Promise<boolean>} - True if setup successful
 */
/**
 * Run schema migrations that need to apply to existing databases.
 * Each migration is idempotent — safe to run repeatedly.
 */
export async function dbSetup(connection) {
  // Migration: add guild_story_id column and backfill per-guild sequential IDs
  const [cols] = await connection.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'story' AND COLUMN_NAME = 'guild_story_id'`
  );
  if (cols.length === 0) {
    log('Migration: adding guild_story_id column...', { show: true });
    await connection.execute(
      `ALTER TABLE story ADD COLUMN guild_story_id INT UNSIGNED NOT NULL DEFAULT 0 AFTER story_id`
    );
    // Backfill: assign sequential IDs per guild in story_id order
    await connection.execute(
      `UPDATE story s
       JOIN (
         SELECT story_id, ROW_NUMBER() OVER (PARTITION BY guild_id ORDER BY story_id ASC) AS rn
         FROM story
       ) t ON s.story_id = t.story_id
       SET s.guild_story_id = t.rn`
    );
    // Add unique constraint after backfill
    await connection.execute(
      `ALTER TABLE story ADD UNIQUE KEY uq_guild_story (guild_id, guild_story_id)`
    );
    log('Migration: guild_story_id column added and backfilled.', { show: true });
  }

  // Migration: add turn_id column to job table for turn-level job cancellation
  const [jobCols] = await connection.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job' AND COLUMN_NAME = 'turn_id'`
  );
  if (jobCols.length === 0) {
    log('Migration: adding turn_id column to job table...', { show: true });
    await connection.execute(`ALTER TABLE job ADD COLUMN turn_id BIGINT NULL`);
    log('Migration: turn_id column added to job table.', { show: true });
  }

  // Migration: add 'deleted' to story_entry.entry_status enum
  const [enumCols] = await connection.execute(
    `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'story_entry' AND COLUMN_NAME = 'entry_status'`
  );
  if (enumCols.length > 0 && !enumCols[0].COLUMN_TYPE.includes('deleted')) {
    log('Migration: adding deleted status to story_entry.entry_status...', { show: true });
    await connection.execute(
      `ALTER TABLE story_entry MODIFY COLUMN entry_status ENUM('pending','confirmed','discarded','deleted') DEFAULT 'pending'`
    );
    log('Migration: story_entry.entry_status updated.', { show: true });
  }

  // Migration: create story_entry_edit table
  const [editTable] = await connection.execute(`SHOW TABLES LIKE 'story_entry_edit'`);
  if (editTable.length === 0) {
    log('Migration: creating story_entry_edit table...', { show: true });
    await connection.execute(`
      CREATE TABLE story_entry_edit (
        edit_id BIGINT AUTO_INCREMENT PRIMARY KEY,
        entry_id BIGINT NOT NULL,
        content TEXT NOT NULL,
        edited_by VARCHAR(30) NOT NULL,
        edited_by_name VARCHAR(100) NOT NULL,
        edited_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (entry_id) REFERENCES story_entry(story_entry_id) ON DELETE CASCADE
      )
    `);
    log('Migration: story_entry_edit table created.', { show: true });
  }
}

export async function setupDatabase(config) {
  log('Starting database setup...', { show: true });
  
  try {
    // Initialize database connection
    const db = new DB(config.db);
    await db.connect();
    log('Database connection successful', { show: true });

    // Check if tables exist
    const [tables] = await db.connection.execute("SHOW TABLES LIKE 'story'");
    
    if (tables.length === 0) {
      log('Creating database schema...', { show: true });
      
      // Read and execute schema file
      const schemaSQL = fs.readFileSync('db/init.sql', 'utf8');
      
      // Split by semicolon and execute each statement
      const statements = schemaSQL.split(';').filter(stmt => stmt.trim().length > 0);
      
      for (const statement of statements) {
        if (statement.trim()) {
          await db.connection.execute(statement);
        }
      }
      
      log('Database schema created successfully', { show: true });
    } else {
      log('Database schema already exists', { show: true });
    }

    // Run schema migrations for existing databases
    await dbSetup(db.connection);

    // Check if configuration data exists
    const [configRows] = await db.connection.execute('SELECT COUNT(*) as count FROM config');
    const configCount = configRows[0].count;

    if (configCount === 0) {
      log('Loading configuration data...', { show: true });
      
      // Read and execute config file
      const configSQL = fs.readFileSync('db/sample_config.sql', 'utf8');
      
      // Split by semicolon and execute each statement
      const statements = configSQL.split(';').filter(stmt => stmt.trim().length > 0);
      
      for (const statement of statements) {
        if (statement.trim()) {
          await db.connection.execute(statement);
        }
      }
      
      log('Configuration data loaded successfully', { show: true });
    } else {
      log(`Configuration data already exists (${configCount} entries)`, { show: true });
    }

    // Close connection
    await db.disconnect();
    
    log('Database setup completed successfully', { show: true });
    return true;
    
  } catch (error) {
    log(`Database setup failed: ${error}`, { show: true });
    return false;
  }
}