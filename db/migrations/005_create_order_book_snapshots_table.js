const { DBForge } = require('../index');

/**
 * Migration: Create order_book_snapshots table
 * Created: 2025-11-02T00:00:00.000Z
 * 
 * This migration creates the order_book_snapshots table for recovery
 * Assignment requirement: System must recover state after restart
 * 
 * Strategy: Periodically snapshot the entire order book state
 * On restart: Load latest snapshot + replay orders created after snapshot
 * This is faster than replaying all orders from the beginning
 */

async function up(pool) {
  const forge = new DBForge(pool);
  
  forge.add_field({
    snapshot_id: {
      type: 'BIGINT',
      constraint: 20,
      unsigned: true,
      auto_increment: true,
      comment: 'Auto-incrementing snapshot identifier',
    },
    instrument: {
      type: 'VARCHAR',
      constraint: 20,
      null: false,
      comment: 'Trading instrument (e.g., BTC-USD)',
    },
    snapshot_data: {
      type: 'JSON',
      null: false,
      comment: 'Serialized order book state (bids, asks, orders)',
    },
    order_count: {
      type: 'INT',
      constraint: 11,
      unsigned: true,
      null: false,
      default: 0,
      comment: 'Number of orders in this snapshot (for monitoring)',
    },
    snapshot_type: {
      type: 'ENUM',
      constraint: ['scheduled', 'manual', 'shutdown'],
      null: false,
      default: 'scheduled',
      comment: 'How this snapshot was triggered',
    },
    snapshot_at: {
      type: 'TIMESTAMP',
      constraint: 6,
      default: 'CURRENT_TIMESTAMP(6)',
      null: false,
      comment: 'Snapshot creation timestamp with microsecond precision',
    }
  });

  // Add primary key
  forge.add_key('snapshot_id', true);
  
  // Add indexes for queries
  forge.add_key('instrument');                        // Find snapshots by instrument
  forge.add_key('snapshot_at');                       // Chronological queries
  
  // Create table
  await forge.create_table('order_book_snapshots', true, { 
    engine: 'InnoDB',
    charset: 'utf8mb4',
    collate: 'utf8mb4_unicode_ci'
  });
  
  console.log('✓ Created order_book_snapshots table for recovery strategy');
}

async function down(pool) {
  const forge = new DBForge(pool);
  
  await forge.drop_table('order_book_snapshots');
  
  console.log('✓ Dropped order_book_snapshots table');
}

module.exports = { up, down };

