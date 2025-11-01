const { DBForge } = require('../index');

/**
 * Migration: Create trades table
 * Created: 2025-11-02T00:00:00.000Z
 * 
 * This migration creates the trades table to store all matched executions
 * Each trade represents a match between a buy order and a sell order
 * Includes foreign key relationships to orders table
 */

async function up(pool) {
  const forge = new DBForge(pool);
  
  forge.add_field({
    trade_id: {
      type: 'VARCHAR',
      constraint: 36,
      null: false,
      comment: 'Trade identifier (UUID format) - Primary Key',
    },
    buy_order_id: {
      type: 'VARCHAR',
      constraint: 36,
      null: false,
      comment: 'Foreign key to orders table (buy side)',
    },
    sell_order_id: {
      type: 'VARCHAR',
      constraint: 36,
      null: false,
      comment: 'Foreign key to orders table (sell side)',
    },
    instrument: {
      type: 'VARCHAR',
      constraint: 20,
      null: false,
      comment: 'Trading instrument (e.g., BTC-USD)',
    },
    price: {
      type: 'DECIMAL',
      constraint: '20,8',
      null: false,
      comment: 'Execution price',
    },
    quantity: {
      type: 'DECIMAL',
      constraint: '20,8',
      null: false,
      comment: 'Executed quantity',
    },
    buy_client_id: {
      type: 'VARCHAR',
      constraint: 50,
      null: false,
      comment: 'Client who placed the buy order',
    },
    sell_client_id: {
      type: 'VARCHAR',
      constraint: 50,
      null: false,
      comment: 'Client who placed the sell order',
    },
    executed_at: {
      type: 'TIMESTAMP',
      constraint: 6,
      default: 'CURRENT_TIMESTAMP(6)',
      null: false,
      comment: 'Trade execution timestamp with microsecond precision',
    }
  });

  // Add primary key on trade_id
  forge.add_key('trade_id', true);
  
  // Add indexes for queries
  forge.add_key('buy_order_id');                    // Find all trades for a buy order
  forge.add_key('sell_order_id');                   // Find all trades for a sell order
  forge.add_key('instrument');                       // Trades by instrument
  forge.add_key('executed_at');                      // Chronological queries
  
  // Create table
  await forge.create_table('trades', true, { 
    engine: 'InnoDB',
    charset: 'utf8mb4',
    collate: 'utf8mb4_unicode_ci'
  });
  
  // Add foreign key constraints
  // Note: DBForge might not support foreign keys directly, so we'll use raw SQL
  await pool.query(`
    ALTER TABLE trades
    ADD CONSTRAINT fk_trades_buy_order
    FOREIGN KEY (buy_order_id) REFERENCES orders(order_id)
    ON DELETE RESTRICT ON UPDATE CASCADE
  `);
  
  await pool.query(`
    ALTER TABLE trades
    ADD CONSTRAINT fk_trades_sell_order
    FOREIGN KEY (sell_order_id) REFERENCES orders(order_id)
    ON DELETE RESTRICT ON UPDATE CASCADE
  `);
  
  console.log('✓ Created trades table with foreign key relationships');
}

async function down(pool) {
  const forge = new DBForge(pool);
  
  // Drop foreign key constraints first
  await pool.query('ALTER TABLE trades DROP FOREIGN KEY fk_trades_buy_order');
  await pool.query('ALTER TABLE trades DROP FOREIGN KEY fk_trades_sell_order');
  
  // Drop table
  await forge.drop_table('trades');
  
  console.log('✓ Dropped trades table and foreign key constraints');
}

module.exports = { up, down };

