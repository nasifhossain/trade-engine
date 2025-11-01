const { DBForge, createPoolFromEnv } = require('./index');
const fs = require('fs');
const path = require('path');

/**
 * Migration Runner - handles database migrations
 */
class MigrationRunner {
  constructor(pool = null) {
    this.pool = pool || createPoolFromEnv();
    this.migrationsPath = path.join(__dirname, 'migrations');
  }

  /**
   * Ensure migrations table exists
   */
  async _ensureMigrationsTable() {
    try {
      // First ensure we're using the correct database
      const dbName = process.env.MYSQL_DATABASE || 'twocents_db';
      await this.pool.query(`USE \`${dbName}\``);
      
      const forge = new DBForge(this.pool);
      
      forge.add_field({
        id: {
          type: 'INT',
          constraint: 11,
          unsigned: true,
          auto_increment: true
        },
        migration: {
          type: 'VARCHAR',
          constraint: 255,
          null: false
        },
        batch: {
          type: 'INT',
          constraint: 11,
          null: false
        },
        executed_at: {
          type: 'TIMESTAMP',
          default: 'CURRENT_TIMESTAMP'
        }
      });
      
      forge.add_key('id', true);
      
      await forge.create_table('migrations', true);
      console.log(`✓ Migrations table ready in database: ${dbName}`);
    } catch (error) {
      console.error('Error ensuring migrations table:', error.message);
      throw error;
    }
  }

  /**
   * Get executed migrations from database
   */
  async _getExecutedMigrations() {
    const [rows] = await this.pool.query('SELECT migration FROM migrations ORDER BY id');
    return rows.map(row => row.migration);
  }

  /**
   * Get migration files from filesystem
   */
  _getMigrationFiles() {
    if (!fs.existsSync(this.migrationsPath)) {
      fs.mkdirSync(this.migrationsPath, { recursive: true });
      return [];
    }
    
    return fs.readdirSync(this.migrationsPath)
      .filter(file => file.endsWith('.js'))
      .sort();
  }

  /**
   * Get next batch number
   */
  async _getNextBatch() {
    const [rows] = await this.pool.query('SELECT MAX(batch) as max_batch FROM migrations');
    return (rows[0].max_batch || 0) + 1;
  }

  /**
   * Record migration execution
   */
  async _recordMigration(migrationName, batch) {
    await this.pool.query(
      'INSERT INTO migrations (migration, batch) VALUES (?, ?)',
      [migrationName, batch]
    );
  }

  /**
   * Remove migration record
   */
  async _removeMigrationRecord(migrationName) {
    await this.pool.query('DELETE FROM migrations WHERE migration = ?', [migrationName]);
  }

  /**
   * Run pending migrations
   * @param {number} limit - Optional limit of migrations to run (0 = all)
   */
  async migrate(limit = 0) {
    await this._ensureMigrationsTable();
    
    const executedMigrations = await this._getExecutedMigrations();
    const migrationFiles = this._getMigrationFiles();
    let pendingMigrations = migrationFiles.filter(file => !executedMigrations.includes(file));
    
    if (pendingMigrations.length === 0) {
      console.log('No pending migrations found.');
      return;
    }
    
    // Limit migrations if specified
    if (limit > 0) {
      pendingMigrations = pendingMigrations.slice(0, limit);
    }
    
    const batch = await this._getNextBatch();
    
    console.log(`Running ${pendingMigrations.length} migration(s)...`);
    console.log(`Database: ${process.env.MYSQL_DATABASE || 'twocents_db'}`);
    
    for (const migrationFile of pendingMigrations) {
      console.log(`Migrating: ${migrationFile}`);
      
      try {
        const migrationPath = path.join(this.migrationsPath, migrationFile);
        
        // Clear require cache to ensure fresh load
        delete require.cache[require.resolve(migrationPath)];
        const migration = require(migrationPath);
        
        if (typeof migration.up !== 'function') {
          throw new Error(`Migration ${migrationFile} must export an 'up' function`);
        }
        
        await migration.up(this.pool);
        await this._recordMigration(migrationFile, batch);
        
        console.log(`✓ Migrated: ${migrationFile}`);
      } catch (error) {
        console.error(`✗ Error in migration ${migrationFile}:`, error.message);
        throw error;
      }
    }
    
    console.log('Migration completed successfully.');
  }

  /**
   * Rollback migrations (last batch or specific steps)
   */
  async rollback(steps = 1) {
    await this._ensureMigrationsTable();
    
    if (steps === 0) {
      console.log('No rollback steps specified.');
      return;
    }
    
    // Get migrations to rollback
    const [rows] = await this.pool.query(
      'SELECT migration, batch FROM migrations ORDER BY id DESC LIMIT ?',
      [steps]
    );
    
    if (rows.length === 0) {
      console.log('No migrations to rollback.');
      return;
    }
    
    console.log(`Rolling back ${rows.length} migration(s)...`);
    
    for (const row of rows) {
      console.log(`Rolling back: ${row.migration}`);
      
      try {
        const migrationPath = path.join(this.migrationsPath, row.migration);
        
        if (!fs.existsSync(migrationPath)) {
          console.log(`Warning: Migration file ${row.migration} not found, removing record only.`);
          await this._removeMigrationRecord(row.migration);
          continue;
        }
        
        const migration = require(migrationPath);
        
        if (typeof migration.down !== 'function') {
          console.log(`Warning: Migration ${row.migration} has no 'down' method, removing record only.`);
        } else {
          await migration.down(this.pool);
        }
        
        await this._removeMigrationRecord(row.migration);
        
        console.log(`✓ Rolled back: ${row.migration}`);
      } catch (error) {
        console.error(`✗ Error rolling back ${row.migration}:`, error.message);
        throw error;
      }
    }
    
    console.log('Rollback completed successfully.');
  }

  /**
   * Show migration status
   */
  async status() {
    await this._ensureMigrationsTable();
    
    const executedMigrations = await this._getExecutedMigrations();
    const migrationFiles = this._getMigrationFiles();
    
    console.log('Migration Status:');
    console.log('================');
    
    if (migrationFiles.length === 0) {
      console.log('No migration files found.');
      return;
    }
    
    for (const file of migrationFiles) {
      const status = executedMigrations.includes(file) ? '✓ Executed' : '✗ Pending';
      console.log(`${status}: ${file}`);
    }
  }

  /**
   * Create a new migration file
   */
  createMigration(name) {
    if (!name) {
      throw new Error('Migration name is required');
    }
    
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    const fileName = `${timestamp}_${name.toLowerCase().replace(/\s+/g, '_')}.js`;
    const filePath = path.join(this.migrationsPath, fileName);
    
    if (!fs.existsSync(this.migrationsPath)) {
      fs.mkdirSync(this.migrationsPath, { recursive: true });
    }
    
    const template = `const { DBForge } = require('../index');

/**
 * Migration: ${name}
 * Created: ${new Date().toISOString()}
 */

async function up(pool) {
  const forge = new DBForge(pool);
  
  // Add your 'up' migration logic here
  // Example:
  // forge.add_field({
  //   id: { type: 'INT', constraint: 11, unsigned: true, auto_increment: true },
  //   name: { type: 'VARCHAR', constraint: 255, null: false }
  // });
  // forge.add_key('id', true);
  // await forge.create_table('example_table');
  
  console.log('Migration ${name} completed');
}

async function down(pool) {
  const forge = new DBForge(pool);
  
  // Add your 'down' migration logic here
  // Example:
  // await forge.drop_table('example_table');
  
  console.log('Migration ${name} rolled back');
}

module.exports = { up, down };
`;
    
    fs.writeFileSync(filePath, template);
    console.log(`Created migration: ${fileName}`);
    
    return fileName;
  }

  /**
   * Close database connection
   */
  async close() {
    if (this.pool) {
      await this.pool.end();
    }
  }
}

module.exports = { MigrationRunner };