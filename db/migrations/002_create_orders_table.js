const { DBForge } = require('../index');

/**
 * Migration: Create orders table
 * Created: 2025-11-02T00:00:00.000Z
 * 
 * This migration creates the orders table with all specified fields
 * including proper ENUM types and DECIMAL precision for financial data
 */

async function up(pool) {
  const forge = new DBForge(pool);
  
  forge.add_field({
    id:{
        type: 'INT',
        constraint: 11,
        unsigned: true,
        auto_increment: true
    },
    order_id: {
      type: 'VARCHAR',
      constraint: 36,
      null: false,
      comment: 'Order identifier (UUID format)',
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
      comment: 'Trading instrument symbol',
    },
    side: {
      type: 'ENUM',
      constraint: ['buy', 'sell'],
      null: false,
      comment: 'Order side - buy or sell',
    },
    type: {
      type: 'ENUM',
      constraint: ['market', 'limit', 'stop', 'stop_limit'],
      null: false,
      comment: 'Order type',
    },
    price: {
      type: 'DECIMAL',
      constraint: '20,8',
      null: false,
      comment: 'Order price with high precision for financial data',
    },
    quantity: {
      type: 'DECIMAL',
      constraint: '20,8',
      null: false,
      comment: 'Order quantity with high precision',
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
      constraint: ['pending', 'partial', 'filled', 'cancelled', 'rejected'],
      null: false,
      default: 'pending',
      comment: 'Current order status',
    },
    created_at: {
      type: 'TIMESTAMP',
      default: 'CURRENT_TIMESTAMP',
      null: false,
      comment: 'Order creation timestamp',
    },
    updated_at: {
      type: 'TIMESTAMP',
      default: 'CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
      null: false,
      comment: 'Last update timestamp',
    }
  });

  // Add primary key
  forge.add_key('id', true);
  
  // Add indexes for common queries
  forge.add_key('client_id');        // Index on client_id for client queries
  forge.add_key('instrument');       // Index on instrument for symbol queries
  forge.add_key('status');           // Index on status for status-based queries
  
  // Create table with InnoDB engine for transaction support
  await forge.create_table('orders', true, { 
    engine: 'InnoDB',
    charset: 'utf8mb4',
    collate: 'utf8mb4_unicode_ci'
  });
  
  console.log('✓ Created orders table with all fields and indexes');
}

async function down(pool) {
  const forge = new DBForge(pool);
  
  await forge.drop_table('orders');
  
  console.log('✓ Dropped orders table');
}

module.exports = { up, down };