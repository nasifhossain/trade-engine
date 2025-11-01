const { DBForge } = require('../index');

/**
 * Migration: Create idempotency_keys table
 * Created: 2025-11-02T00:00:00.000Z
 * 
 * This migration creates the idempotency_keys table to prevent duplicate order submissions
 * Assignment requirement: API must support idempotent order submission
 * 
 * When the same idempotency_key is submitted multiple times:
 * - Return the same result
 * - Do not create duplicate orders
 * - Do not match the same order twice
 */

async function up(pool) {
  const forge = new DBForge(pool);
  
  forge.add_field({
    idempotency_key: {
      type: 'VARCHAR',
      constraint: 255,
      null: false,
      comment: 'Client-provided idempotency key - Primary Key',
    },
    order_id: {
      type: 'VARCHAR',
      constraint: 36,
      null: false,
      comment: 'Foreign key to orders table',
    },
    response_data: {
      type: 'JSON',
      null: true,
      comment: 'Cached API response for duplicate requests',
    },
    http_status: {
      type: 'INT',
      constraint: 3,
      null: false,
      default: 200,
      comment: 'HTTP status code of original response',
    },
    created_at: {
      type: 'TIMESTAMP',
      default: 'CURRENT_TIMESTAMP',
      null: false,
      comment: 'When idempotency key was first seen',
    },
    expires_at: {
      type: 'TIMESTAMP',
      null: true,
      comment: 'Optional expiration for cleanup (e.g., 24 hours)',
    }
  });

  // Add primary key on idempotency_key
  forge.add_key('idempotency_key', true);
  
  // Add index on order_id for lookups
  forge.add_key('order_id');
  
  // Add index on expires_at for cleanup jobs
  forge.add_key('expires_at');
  
  // Create table
  await forge.create_table('idempotency_keys', true, { 
    engine: 'InnoDB',
    charset: 'utf8mb4',
    collate: 'utf8mb4_unicode_ci'
  });
  
  // Add foreign key constraint to orders table
  await pool.query(`
    ALTER TABLE idempotency_keys
    ADD CONSTRAINT fk_idempotency_order
    FOREIGN KEY (order_id) REFERENCES orders(order_id)
    ON DELETE CASCADE ON UPDATE CASCADE
  `);
  
  console.log('✓ Created idempotency_keys table with foreign key to orders');
}

async function down(pool) {
  const forge = new DBForge(pool);
  
  // Drop foreign key constraint first
  await pool.query('ALTER TABLE idempotency_keys DROP FOREIGN KEY fk_idempotency_order');
  
  // Drop table
  await forge.drop_table('idempotency_keys');
  
  console.log('✓ Dropped idempotency_keys table');
}

module.exports = { up, down };

