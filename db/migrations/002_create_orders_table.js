const { DBForge } = require('../index');

/**
 * Migration: Create orders table
 * Created: 2025-11-02T00:00:00.000Z
 * 
 * This migration creates the orders table for the trading engine
 * Supports limit and market orders with microsecond precision timestamps
 * Assignment requirements: price-time priority matching
 */

async function up(pool) {
  const forge = new DBForge(pool);
  
  forge.add_field({
    order_id: {
      type: 'VARCHAR',
      constraint: 36,
      null: false,
      comment: 'Order identifier (UUID format) - Primary Key',
    },
    client_id: {
      type: 'VARCHAR',
      constraint: 50,
      null: false,
      comment: 'Client identifier',
    },
    instrument: {
      type: 'VARCHAR',
      constraint: 20,
      null: false,
      comment: 'Trading instrument (e.g., BTC-USD)',
    },
    side: {
      type: 'ENUM',
      constraint: ['buy', 'sell'],
      null: false,
      comment: 'Order side - buy or sell',
    },
    type: {
      type: 'ENUM',
      constraint: ['market', 'limit'],
      null: false,
      comment: 'Order type - market or limit',
    },
    price: {
      type: 'DECIMAL',
      constraint: '20,8',
      null: true,
      comment: 'Order price (NULL for market orders)',
    },
    quantity: {
      type: 'DECIMAL',
      constraint: '20,8',
      null: false,
      comment: 'Order quantity',
    },
    filled_quantity: {
      type: 'DECIMAL',
      constraint: '20,8',
      null: false,
      default: 0.00000000,
      comment: 'Quantity that has been filled',
    },
    status: {
      type: 'ENUM',
      constraint: ['open', 'partially_filled', 'filled', 'cancelled', 'rejected'],
      null: false,
      default: 'open',
      comment: 'Current order status',
    },
    created_at: {
      type: 'TIMESTAMP',
      constraint: 6,
      default: 'CURRENT_TIMESTAMP(6)',
      null: false,
      comment: 'Order creation timestamp with microsecond precision',
    },
    updated_at: {
      type: 'TIMESTAMP',
      constraint: 6,
      default: 'CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)',
      null: false,
      comment: 'Last update timestamp with microsecond precision',
    }
  });

  // Add primary key on order_id
  forge.add_key('order_id', true);
  
  // Add indexes for matching engine queries
  forge.add_key('client_id');                        // Client queries
  forge.add_key('instrument');                       // Instrument queries
  forge.add_key('status');                           // Status queries
  forge.add_key('created_at');                       // Price-time priority
  
  // Create table with InnoDB engine for ACID transactions
  await forge.create_table('orders', true, { 
    engine: 'InnoDB',
    charset: 'utf8mb4',
    collate: 'utf8mb4_unicode_ci'
  });
  
  console.log('✓ Created orders table with microsecond precision and optimized indexes');
}

async function down(pool) {
  const forge = new DBForge(pool);
  
  await forge.drop_table('orders');
  
  console.log('✓ Dropped orders table');
}

module.exports = { up, down };