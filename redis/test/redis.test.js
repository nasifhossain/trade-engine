/**
 * Redis Service Tests
 * 
 * To run: npm test redis/test/redis.test.js
 * Or: node redis/test/redis.test.js
 */

const { createRedisClient } = require('../client');
const RedisService = require('../RedisService');

async function runTests() {
  let client;
  let service;

  try {
    console.log('🧪 Starting Redis Service Tests...\n');

    // Setup
    console.log('📦 Setting up Redis connection...');
    client = await createRedisClient();
    service = new RedisService(client);
    console.log('✓ Connected to Redis\n');

    // Test 1: Health Check
    console.log('Test 1: Health Check');
    const health = await service.healthCheck();
    console.assert(health.healthy === true, 'Health check should be healthy');
    console.log(`✓ Health: ${JSON.stringify(health)}\n`);

    // Test 2: Order Book Operations
    console.log('Test 2: Order Book Operations');
    const instrument = 'BTC-USD-TEST';
    
    // Add buy orders
    await service.addOrderToBook(instrument, 'buy', 50000, 'order1', Date.now());
    await service.addOrderToBook(instrument, 'buy', 49900, 'order2', Date.now() + 1);
    await service.addOrderToBook(instrument, 'buy', 50100, 'order3', Date.now() + 2);
    
    // Add sell orders
    await service.addOrderToBook(instrument, 'sell', 50200, 'order4', Date.now());
    await service.addOrderToBook(instrument, 'sell', 50300, 'order5', Date.now() + 1);
    
    const orderBook = await service.getOrderBook(instrument, 5);
    console.log('Order Book:', JSON.stringify(orderBook, null, 2));
    console.assert(orderBook.bids.length > 0, 'Should have bids');
    console.assert(orderBook.asks.length > 0, 'Should have asks');
    console.log('✓ Order book operations successful\n');

    // Test 3: Order Details
    console.log('Test 3: Order Details Storage');
    const orderData = {
      order_id: 'order123',
      client_id: 'client1',
      instrument: 'BTC-USD',
      side: 'buy',
      order_type: 'limit',
      price: 50000,
      quantity: 1.5,
      filled_quantity: 0,
      status: 'open',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    await service.storeOrderDetails('order123', orderData);
    const retrievedOrder = await service.getOrderDetails('order123');
    console.log('Stored & Retrieved:', JSON.stringify(retrievedOrder, null, 2));
    console.assert(retrievedOrder.order_id === 'order123', 'Order ID should match');
    console.assert(retrievedOrder.price === 50000, 'Price should match');
    console.log('✓ Order details storage successful\n');

    // Test 4: Update Order Status
    console.log('Test 4: Update Order Status');
    await service.updateOrderStatus('order123', 'filled', 1.5);
    const updatedOrder = await service.getOrderDetails('order123');
    console.assert(updatedOrder.status === 'filled', 'Status should be updated');
    console.assert(updatedOrder.filled_quantity === 1.5, 'Filled quantity should be updated');
    console.log('✓ Order status update successful\n');

    // Test 5: Recent Trades
    console.log('Test 5: Recent Trades');
    const trade = {
      trade_id: 'trade1',
      buy_order_id: 'order1',
      sell_order_id: 'order4',
      price: 50100,
      quantity: 0.5,
      executed_at: new Date().toISOString()
    };
    
    await service.addRecentTrade(instrument, trade);
    const trades = await service.getRecentTrades(instrument, 10);
    console.log('Recent Trades:', JSON.stringify(trades, null, 2));
    console.assert(trades.length > 0, 'Should have trades');
    console.assert(trades[0].trade_id === 'trade1', 'Trade ID should match');
    console.log('✓ Recent trades successful\n');

    // Test 6: Idempotency Keys
    console.log('Test 6: Idempotency Keys');
    const idempotencyKey = 'test-key-123';
    
    // Check non-existent key
    let existingOrder = await service.checkIdempotencyKey(idempotencyKey);
    console.assert(existingOrder === null, 'Key should not exist initially');
    
    // Store key
    await service.storeIdempotencyKey(idempotencyKey, 'order456', 10);
    
    // Check existing key
    existingOrder = await service.checkIdempotencyKey(idempotencyKey);
    console.assert(existingOrder === 'order456', 'Key should return order ID');
    console.log('✓ Idempotency keys successful\n');

    // Test 7: Rate Limiting
    console.log('Test 7: Rate Limiting');
    const clientId = 'test-client';
    
    // First request should be allowed
    let rateLimit = await service.checkRateLimit(clientId, 5, 60);
    console.assert(rateLimit.allowed === true, 'First request should be allowed');
    console.log(`Rate limit check: allowed=${rateLimit.allowed}, remaining=${rateLimit.remaining}`);
    
    // Make more requests
    for (let i = 0; i < 4; i++) {
      rateLimit = await service.checkRateLimit(clientId, 5, 60);
    }
    
    // 6th request should be denied
    rateLimit = await service.checkRateLimit(clientId, 5, 60);
    console.assert(rateLimit.allowed === false, 'Request over limit should be denied');
    console.log(`Rate limit exceeded: allowed=${rateLimit.allowed}, remaining=${rateLimit.remaining}`);
    console.log('✓ Rate limiting successful\n');

    // Test 8: Metrics
    console.log('Test 8: Metrics');
    await service.incrementMetric('orders:created', 5);
    await service.incrementMetric('orders:filled', 3);
    
    const ordersCreated = await service.getMetric('orders:created');
    console.assert(ordersCreated >= 5, 'Metric should be incremented');
    
    const allMetrics = await service.getAllMetrics('metrics:orders:*');
    console.log('All Metrics:', allMetrics);
    console.log('✓ Metrics successful\n');

    // Cleanup
    console.log('🧹 Cleaning up test data...');
    await service.clearInstrument(instrument);
    await client.del('order:order123');
    await client.del(`idempotency:${idempotencyKey}`);
    await client.del(`ratelimit:${clientId}`);
    await client.del('metrics:orders:created');
    await client.del('metrics:orders:filled');

    console.log('\n✅ All tests passed!');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  } finally {
    if (client) {
      await client.quit();
      console.log('✓ Redis connection closed');
    }
  }
}

// Run tests if executed directly
if (require.main === module) {
  runTests();
}

module.exports = runTests;

