#!/usr/bin/env node

/**
 * Migration CLI - Similar to PHP CLI migrate commands
 * Usage: 
 *   node cli/migrate.js status
 *   node cli/migrate.js all
 *   node cli/migrate.js up
 *   node cli/migrate.js down [steps]
 *   node cli/migrate.js create <name>
 */

const { MigrationRunner } = require('../db/migration');
const { createPoolFromEnv } = require('../db/index');
const fs = require('fs');
const path = require('path');

class MigrationCLI {
  constructor() {
    this.runner = new MigrationRunner();
  }

  async status() {
    console.log('Migration Status Check');
    console.log('=====================');
    
    try {
      await this.runner.status();
    } catch (error) {
      console.error('Error checking migration status:', error.message);
      process.exitCode = 1;
    } finally {
      await this.runner.close();
    }
  }

  async all() {
    console.log('Running All Pending Migrations');
    console.log('==============================');
    
    try {
      await this.runner.migrate();
    } catch (error) {
      console.error('Error running migrations:', error.message);
      process.exitCode = 1;
    } finally {
      await this.runner.close();
    }
  }

  async up() {
    console.log('Running Migration Up');
    console.log('===================');
    
    try {
      await this.runner.migrate();
    } catch (error) {
      console.error('Error running migration up:', error.message);
      process.exitCode = 1;
    } finally {
      await this.runner.close();
    }
  }

  async down(steps = 1) {
    console.log(`Rolling Back ${steps} Migration(s)`);
    console.log('================================');
    
    try {
      await this.runner.rollback(parseInt(steps));
    } catch (error) {
      console.error('Error rolling back migrations:', error.message);
      process.exitCode = 1;
    } finally {
      await this.runner.close();
    }
  }

  async create(name) {
    if (!name) {
      console.error('Migration name is required');
      console.log('Usage: node cli/migrate.js create <migration_name>');
      process.exitCode = 1;
      return;
    }

    console.log(`Creating New Migration: ${name}`);
    console.log('==============================');
    
    try {
      const fileName = this.runner.createMigration(name);
      console.log(`✓ Migration created: ${fileName}`);
      console.log(`Edit the file: db/migrations/${fileName}`);
    } catch (error) {
      console.error('Error creating migration:', error.message);
      process.exitCode = 1;
    }
  }

  async reset() {
    console.log('Resetting All Migrations');
    console.log('========================');
    console.log('WARNING: This will rollback ALL migrations!');
    
    try {
      // Get all executed migrations and rollback
      const pool = createPoolFromEnv();
      const [rows] = await pool.query('SELECT COUNT(*) as count FROM migrations');
      const migrationCount = rows[0].count;
      
      if (migrationCount > 0) {
        await this.runner.rollback(migrationCount);
        console.log(`✓ Rolled back ${migrationCount} migration(s)`);
      } else {
        console.log('No migrations to rollback');
      }
      
      await pool.end();
    } catch (error) {
      console.error('Error resetting migrations:', error.message);
      process.exitCode = 1;
    } finally {
      await this.runner.close();
    }
  }

  async refresh() {
    console.log('Refreshing Migrations (Reset + Migrate)');
    console.log('=======================================');
    
    try {
      await this.reset();
      await this.all();
      console.log('✓ Migration refresh completed');
    } catch (error) {
      console.error('Error refreshing migrations:', error.message);
      process.exitCode = 1;
    }
  }

  showHelp() {
    console.log(`
Migration CLI - Database Migration Management
============================================

Usage: node cli/migrate.js <command> [options]

Commands:
  status              Show migration status (which migrations have been run)
  all                 Run all pending migrations
  up                  Run next pending migration
  down [steps]        Rollback migrations (default: 1 step)
  create <name>       Create a new migration file
  reset               Rollback all migrations
  refresh             Reset and re-run all migrations (reset + all)

Examples:
  node cli/migrate.js status
  node cli/migrate.js all
  node cli/migrate.js down 3
  node cli/migrate.js create create_products_table

Docker Usage (similar to your PHP project):
  docker exec -it <container_name> node cli/migrate.js status
  docker exec -it <container_name> node cli/migrate.js all
`);
  }
}

async function main() {
  const command = process.argv[2];
  const arg = process.argv[3];
  
  const cli = new MigrationCLI();

  switch (command) {
    case 'status':
      await cli.status();
      break;
    
    case 'all':
      await cli.all();
      break;
    
    case 'up':
      await cli.up();
      break;
    
    case 'down':
      await cli.down(arg);
      break;
    
    case 'create':
      await cli.create(arg);
      break;
    
    case 'reset':
      await cli.reset();
      break;
    
    case 'refresh':
      await cli.refresh();
      break;
    
    case 'help':
    case '--help':
    case '-h':
      cli.showHelp();
      break;
    
    default:
      if (command) {
        console.error(`Unknown command: ${command}`);
      }
      cli.showHelp();
      process.exitCode = 1;
      break;
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Unexpected error:', error);
    process.exitCode = 1;
  });
}

module.exports = { MigrationCLI };