#!/usr/bin/env node
const { DBForge, TableManager, createPoolFromEnv } = require('./index');
const { MigrationRunner } = require('./migration');

async function main() {
  const cmd = process.argv[2];
  const arg1 = process.argv[3];
  const arg2 = process.argv[4];

  try {
    switch (cmd) {
      case 'create':
        await handleCreate(arg1, arg2);
        break;
      
      case 'drop':
        await handleDrop(arg1);
        break;
      
      case 'migrate':
        await handleMigrate();
        break;
      
      case 'rollback':
        await handleRollback(arg1);
        break;
      
      case 'migration:status':
        await handleMigrationStatus();
        break;
      
      case 'migration:create':
        await handleCreateMigration(arg1);
        break;
      
      case 'example':
        await handleExamples(arg1);
        break;
      
      default:
        showUsage();
        break;
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exitCode = 1;
  }
}

async function handleCreate(tableName, tableType) {
  const pool = createPoolFromEnv();
  
  try {
    if (!tableName) {
      await createExampleTables(pool);
      return;
    }

    if (tableType === 'users') {
      await createUsersTable(pool);
    } else if (tableType === 'slots') {
      await createSlotsTable(pool);
    } else {
      console.log(`Unknown table type: ${tableType}`);
      console.log('Available types: users, slots');
    }
  } finally {
    await pool.end();
  }
}

async function handleDrop(tableName) {
  const pool = createPoolFromEnv();
  
  try {
    if (!tableName) {
      console.log('Table name required. Usage: node db/run.js drop <table_name>');
      return;
    }

    await TableManager.dropTable(tableName, pool);
    console.log(`✓ Dropped table: ${tableName}`);
  } finally {
    await pool.end();
  }
}

async function handleMigrate() {
  const runner = new MigrationRunner();
  
  try {
    await runner.migrate();
  } finally {
    await runner.close();
  }
}

async function handleRollback(steps) {
  const runner = new MigrationRunner();
  const rollbackSteps = steps ? parseInt(steps) : 1;
  
  try {
    await runner.rollback(rollbackSteps);
  } finally {
    await runner.close();
  }
}

async function handleMigrationStatus() {
  const runner = new MigrationRunner();
  
  try {
    await runner.status();
  } finally {
    await runner.close();
  }
}

async function handleCreateMigration(name) {
  if (!name) {
    console.log('Migration name required. Usage: node db/run.js migration:create <migration_name>');
    return;
  }
  
  const runner = new MigrationRunner();
  runner.createMigration(name);
}

async function handleExamples(exampleType) {
  const pool = createPoolFromEnv();
  
  try {
    if (exampleType === 'users') {
      await createUsersTable(pool);
    } else if (exampleType === 'slots') {
      await createSlotsTable(pool);
    } else {
      await createExampleTables(pool);
    }
  } finally {
    await pool.end();
  }
}

async function createUsersTable(pool) {
  console.log('Creating users table...');
  
  const forge = new DBForge(pool);
  
  forge.add_field({
    id: {
      type: 'INT',
      constraint: 11,
      unsigned: true,
      auto_increment: true,
    },
    name: {
      type: 'VARCHAR',
      constraint: 255,
      null: false,
    },
    email: {
      type: 'VARCHAR', 
      constraint: 255,
      null: false,
      unique: true,
    },
    email_verified_at: {
      type: 'TIMESTAMP',
      null: true,
    },
    password: {
      type: 'VARCHAR',
      constraint: 255,
      null: false,
    },
    remember_token: {
      type: 'VARCHAR',
      constraint: 100,
      null: true,
    },
    created_at: {
      type: 'TIMESTAMP',
      default: 'CURRENT_TIMESTAMP',
    },
    updated_at: {
      type: 'TIMESTAMP',
      default: 'CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
    }
  });
  
  forge.add_key('id', true);
  forge.add_key('email');
  
  await forge.create_table('users', true, { engine: 'InnoDB' });
  console.log('✓ Users table created successfully');
}

async function createSlotsTable(pool) {
  console.log('Creating slots table...');
  
  const forge = new DBForge(pool);
  
  forge.add_field({
    id: {
      type: 'INT',
      constraint: 11,
      unsigned: true,
      auto_increment: true,
    },
    doctor_id: {
      type: 'INT',
      constraint: 11,
      unsigned: true,
      null: false,
      comment: 'Reference to doctors table',
    },
    day: {
      type: 'VARCHAR',
      constraint: 20,
      null: false,
      comment: 'Weekday or date identifier',
    },
    intervals: {
      type: 'JSON',
      null: false,
      comment: 'JSON array of interval definitions',
    },
    base_price: {
      type: 'DECIMAL',
      constraint: '10,2',
      null: true,
      default: null,
      comment: 'Base price per slot',
    },
    global_delay: {
      type: 'DOUBLE',
      null: false,
      default: 0,
      comment: 'Global delay in minutes',
    },
    slot_time: {
      type: 'DATETIME',
      null: false,
      comment: 'Start time of the slot',
    },
    capacity: {
      type: 'INT',
      constraint: 11,
      default: 1,
      null: false,
    },
    booked_count: {
      type: 'INT',
      constraint: 11,
      default: 0,
      null: false,
    },
    status: {
      type: 'ENUM',
      constraint: ['available', 'full', 'inactive'],
      default: 'available',
    },
    created_at: {
      type: 'TIMESTAMP',
      default: 'CURRENT_TIMESTAMP',
    },
    updated_at: {
      type: 'TIMESTAMP',
      default: 'CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
    },
  });
  
  forge.add_key('id', true);
  forge.add_key('slot_time');
  forge.add_key('status');
  forge.add_key('doctor_id');
  
  await forge.create_table('slots', true, { engine: 'InnoDB' });
  console.log('✓ Slots table created successfully');
}

async function createExampleTables(pool) {
  console.log('Creating example tables...');
  await createUsersTable(pool);
  await createSlotsTable(pool);
}

function showUsage() {
  console.log(`
Database Management CLI

Usage: node db/run.js <command> [options]

Commands:
  create [table_type]          Create tables (users, slots, or all if no type specified)
  drop <table_name>            Drop a specific table
  
  migrate                      Run pending migrations
  rollback [steps]             Rollback migrations (default: 1 step)
  migration:status             Show migration status
  migration:create <name>      Create a new migration file
  
  example [table_type]         Create example tables (same as create)

Examples:
  node db/run.js create users        # Create users table
  node db/run.js create slots        # Create slots table  
  node db/run.js create              # Create all example tables
  node db/run.js drop users          # Drop users table
  
  node db/run.js migrate             # Run all pending migrations
  node db/run.js rollback            # Rollback last migration
  node db/run.js rollback 3          # Rollback last 3 migrations
  node db/run.js migration:status    # Show which migrations have been run
  node db/run.js migration:create create_products_table  # Create new migration
`);
}

if (require.main === module) {
  main();
}

module.exports = { main };