/**
 * Database setup utility for Round Robin StoryBot
 * This module provides functions to initialize the database schema and configuration
 */

import fs from 'fs';
import { DB } from './utilities.js';
import { formattedDate } from './utilities.js';

/**
 * Setup database schema and configuration
 * @param {Object} config - Database configuration from config.json
 * @returns {Promise<boolean>} - True if setup successful
 */
/**
 * Run schema migrations that need to apply to existing databases.
 * Each migration is idempotent — safe to run repeatedly.
 */
export async function runMigrations(connection) {
  // Migration: add guild_story_id column and backfill per-guild sequential IDs
  const [cols] = await connection.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'story' AND COLUMN_NAME = 'guild_story_id'`
  );
  if (cols.length === 0) {
    console.log(`${formattedDate()}: Migration: adding guild_story_id column...`);
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
    console.log(`${formattedDate()}: Migration: guild_story_id column added and backfilled.`);
  }
}

export async function setupDatabase(config) {
  console.log(`${formattedDate()}: Starting database setup...`);
  
  try {
    // Initialize database connection
    const db = new DB(config.db);
    await db.connect();
    console.log(`${formattedDate()}: Database connection successful`);

    // Check if tables exist
    const [tables] = await db.connection.execute("SHOW TABLES LIKE 'story'");
    
    if (tables.length === 0) {
      console.log(`${formattedDate()}: Creating database schema...`);
      
      // Read and execute schema file
      const schemaSQL = fs.readFileSync('db/init.sql', 'utf8');
      
      // Split by semicolon and execute each statement
      const statements = schemaSQL.split(';').filter(stmt => stmt.trim().length > 0);
      
      for (const statement of statements) {
        if (statement.trim()) {
          await db.connection.execute(statement);
        }
      }
      
      console.log(`${formattedDate()}: Database schema created successfully`);
    } else {
      console.log(`${formattedDate()}: Database schema already exists`);
    }

    // Run schema migrations for existing databases
    await runMigrations(db.connection);

    // Check if configuration data exists
    const [configRows] = await db.connection.execute('SELECT COUNT(*) as count FROM config');
    const configCount = configRows[0].count;

    if (configCount === 0) {
      console.log(`${formattedDate()}: Loading configuration data...`);
      
      // Read and execute config file
      const configSQL = fs.readFileSync('db/sample_config.sql', 'utf8');
      
      // Split by semicolon and execute each statement
      const statements = configSQL.split(';').filter(stmt => stmt.trim().length > 0);
      
      for (const statement of statements) {
        if (statement.trim()) {
          await db.connection.execute(statement);
        }
      }
      
      console.log(`${formattedDate()}: Configuration data loaded successfully`);
    } else {
      console.log(`${formattedDate()}: Configuration data already exists (${configCount} entries)`);
    }

    // Close connection
    await db.disconnect();
    
    console.log(`${formattedDate()}: Database setup completed successfully`);
    return true;
    
  } catch (error) {
    console.error(`${formattedDate()}: Database setup failed:`, error);
    return false;
  }
}