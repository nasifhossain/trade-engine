const { DBForge } = require('../index');

/**
 * Migration: Create users table
 * Created: 2025-11-02T00:00:00.000Z
 * 
 * This migration creates the users table with standard user fields
 */

async function up(pool) {
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
      comment: 'Full name of the user',
    },
    email: {
      type: 'VARCHAR', 
      constraint: 255,
      null: false,
      comment: 'User email address',
    },
    email_verified_at: {
      type: 'TIMESTAMP',
      null: true,
      comment: 'Timestamp when email was verified',
    },
    password: {
      type: 'VARCHAR',
      constraint: 255,
      null: false,
      comment: 'Hashed password',
    },
    remember_token: {
      type: 'VARCHAR',
      constraint: 100,
      null: true,
      comment: 'Remember me token',
    },
    phone: {
      type: 'VARCHAR',
      constraint: 20,
      null: true,
      comment: 'User phone number',
    },
    status: {
      type: 'ENUM',
      constraint: ['active', 'inactive', 'suspended'],
      default: 'active',
      comment: 'User account status',
    },
    created_at: {
      type: 'TIMESTAMP',
      default: 'CURRENT_TIMESTAMP',
      comment: 'Record creation timestamp',
    },
    updated_at: {
      type: 'TIMESTAMP',
      default: 'CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
      comment: 'Record last update timestamp',
    }
  });

  // Add primary key
  forge.add_key('id', true);
  
  // Add unique index on email
  forge.add_key('email');
  
  // Add index on status for filtering
  // forge.add_key('status');
  
  // Create table with InnoDB engine
  await forge.create_table('users', true, { engine: 'InnoDB' });
  
  console.log('✓ Created users table with all fields and indexes');
}

async function down(pool) {
  const forge = new DBForge(pool);
  
  await forge.drop_table('users');
  
  console.log('✓ Dropped users table');
}

module.exports = { up, down };