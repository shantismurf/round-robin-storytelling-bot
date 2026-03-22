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