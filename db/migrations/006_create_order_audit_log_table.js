const { DBForge } = require('../index');

/**
 * Migration: Create order_audit_log table (Optional but Recommended)
 * Created: 2025-11-02T00:00:00.000Z
 * 
 * This migration creates the order_audit_log table for tracking state changes
 * Useful for:
 * - Debugging matching engine issues
 * - Regulatory compliance and audit trails
 * - Analytics and monitoring
 * - Understanding order lifecycle
 * 
 * Tracks every state transition: open → partially_filled → filled
 *                               open → cancelled
 *                               open → rejected
 */

async function up(pool) {
  const forge = new DBForge(pool);
  
  forge.add_field({
    log_id: {
      type: 'BIGINT',
      constraint: 20,
      unsigned: true,
      auto_increment: true,
      comment: 'Auto-incrementing log entry identifier',
    },
    order_id: {
      type: 'VARCHAR',
      constraint: 36,
      null: false,
      comment: 'Foreign key to orders table',
    },
    old_status: {
      type: 'VARCHAR',
      constraint: 20,
      null: true,
      comment: 'Previous status (NULL for first entry)',
    },
    new_status: {
      type: 'VARCHAR',
      constraint: 20,
      null: false,
      comment: 'New status after this change',
    },
    old_filled_quantity: {
      type: 'DECIMAL',
      constraint: '20,8',
      null: true,
      comment: 'Previous filled quantity',
    },
    new_filled_quantity: {
      type: 'DECIMAL',
      constraint: '20,8',
      null: false,
      comment: 'New filled quantity after this change',
    },
    reason: {
      type: 'VARCHAR',
      constraint: 255,
      null: true,
      comment: 'Reason for change (matched, cancelled_by_client, etc.)',
    },
    trade_id: {
      type: 'VARCHAR',
      constraint: 36,
      null: true,
      comment: 'Related trade_id if this was a match event',
    },
    logged_at: {
      type: 'TIMESTAMP',
      constraint: 6,
      default: 'CURRENT_TIMESTAMP(6)',
      null: false,
      comment: 'When this log entry was created',
    }
  });

  // Add primary key
  forge.add_key('log_id', true);
  
  // Add indexes for queries
  forge.add_key('order_id');                          // All logs for an order
  forge.add_key('trade_id');                          // Find log entry for a trade
  forge.add_key('logged_at');                         // Time-based queries
  
  // Create table
  await forge.create_table('order_audit_log', true, { 
    engine: 'InnoDB',
    charset: 'utf8mb4',
    collate: 'utf8mb4_unicode_ci'
  });
  
  // Add foreign key constraint to orders table
  await pool.query(`
    ALTER TABLE order_audit_log
    ADD CONSTRAINT fk_audit_order
    FOREIGN KEY (order_id) REFERENCES orders(order_id)
    ON DELETE CASCADE ON UPDATE CASCADE
  `);
  
  // Optional: Add foreign key to trades table (if trade_id is not null)
  // Note: This requires a partial index which MySQL doesn't support directly
  // So we'll skip this constraint
  
  console.log('✓ Created order_audit_log table for state change tracking');
}

async function down(pool) {
  const forge = new DBForge(pool);
  
  // Drop foreign key constraint first
  await pool.query('ALTER TABLE order_audit_log DROP FOREIGN KEY fk_audit_order');
  
  // Drop table
  await forge.drop_table('order_audit_log');
  
  console.log('✓ Dropped order_audit_log table');
}

module.exports = { up, down };

