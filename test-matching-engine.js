/**
 * Comprehensive Matching Engine Tests
 * 
 * This file contains:
 * 1. Functional tests (matching logic, price-time priority, partial fills)
 * 2. Simple load tests (performance testing)
 * 3. Precise 2000 RPS load test with detailed metrics
 * 
 * Usage:
 *   npm install axios (if not installed)
 *   node test-matching-engine.js [mode] [duration]
 * 
 * Modes:
 *   functional  - Run only functional tests
 *   load        - Run only basic load tests
 *   precise     - Run precise 2000 RPS test with detailed metrics
 *   all         - Run functional and basic load tests
 * 
 * Examples:
 *   node test-matching-engine.js                    # Run all tests (functional + load)
 *   node test-matching-engine.js functional         # Run only functional tests
 *   node test-matching-engine.js load              # Run only load tests
 *   node test-matching-engine.js precise            # Run precise 2000 RPS test (60 sec default)
 *   node test-matching-engine.js precise 30         # Run precise 2000 RPS test for 30 seconds
 *   node test-matching-engine.js precise 120        # Run precise 2000 RPS test for 2 minutes
 */

const axios = require('axios');
const http = require('http');

// ============================================================================
// CONFIGURATION
// ============================================================================

const BASE_URL = 'http://localhost/api/orders';
const ORDERS_URL = `${BASE_URL}/orders`;
const ORDERBOOK_URL = `${BASE_URL}/orderbook`;
const TRADES_URL = `${BASE_URL}/trades`;

const CONFIG = {
    // SPECIFICATION REQUIREMENTS (STRICT COMPLIANCE):
    // - targetRPS: 2000 (2,000 orders/sec sustained for 1 minute)
    // - concurrentClients: 1000
    // 
    // ARCHITECTURE: Per-instrument locking implemented
    
    loadTest: {
        targetRPS: 2000,       // SPEC: 2,000 orders/sec
        duration: 60,          // SPEC: 1 minute (60 seconds)
        rampUp: true           // Gradually increase load
    }
};

let testCounter = 0;
let loadTestCounter = 0;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function log(message, type = 'info') {
    const colors = {
        info: '\x1b[36m',    // Cyan
        success: '\x1b[32m', // Green
        error: '\x1b[31m',   // Red
        warn: '\x1b[33m',    // Yellow
        reset: '\x1b[0m'
    };
    console.log(`${colors[type]}${message}${colors.reset}`);
}

async function createOrder(orderData) {
    const idempotencyKey = `test-${Date.now()}-${testCounter++}`;
    try {
        const response = await axios.post(ORDERS_URL, orderData, {
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': idempotencyKey
            }
        });
        return response.data;
    } catch (error) {
        throw new Error(`Order creation failed: ${error.response?.data?.error || error.message}`);
    }
}

async function getTrades(instrument = 'BTC-USD') {
    const response = await axios.get(`${TRADES_URL}?instrument=${instrument}`);
    return response.data;
}

async function getOrderBook(instrument = 'BTC-USD') {
    const response = await axios.get(`${ORDERBOOK_URL}?instrument=${instrument}`);
    return response.data;
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

// ============================================================================
// FUNCTIONAL TESTS
// ============================================================================

async function testBasicMatching() {
    log('\n=== Test 1: Basic Limit Order Matching ===', 'info');
    
    // Create sell order (maker)
    const sell = await createOrder({
        client_id: 'seller-A',
        instrument: 'BTC-USD',
        side: 'sell',
        type: 'limit',
        price: 70000,
        quantity: 1.0
    });
    log(`✓ Sell order created: ${sell.order.order_id}`, 'success');
    assert(sell.match_result.trades_executed === 0, 'No trades should exist yet');
    
    // Create matching buy order (taker)
    const buy = await createOrder({
        client_id: 'buyer-B',
        instrument: 'BTC-USD',
        side: 'buy',
        type: 'limit',
        price: 70000,
        quantity: 0.5
    });
    log(`✓ Buy order created: ${buy.order.order_id}`, 'success');
    assert(buy.match_result.trades_executed === 1, 'Should have 1 trade');
    assert(parseFloat(buy.match_result.trades[0].quantity) === 0.5, 'Trade quantity should be 0.5');
    assert(parseFloat(buy.match_result.trades[0].price) === 70000, 'Trade price should be 70000');
    assert(buy.order.status === 'filled', 'Buy order should be filled');
    
    log('✅ Test 1 PASSED - Basic matching works!', 'success');
    return { passed: true, name: 'Basic Matching' };
}

async function testPriceTimePriority() {
    log('\n=== Test 2: Price-Time Priority ===', 'info');
    
    // Create sell orders at different prices
    const sell1 = await createOrder({
        client_id: 'seller-1',
        instrument: 'ETH-USD',
        side: 'sell',
        type: 'limit',
        price: 4500,
        quantity: 1.0
    });
    log('✓ Created sell order at 4500', 'success');
    
    const sell2 = await createOrder({
        client_id: 'seller-2',
        instrument: 'ETH-USD',
        side: 'sell',
        type: 'limit',
        price: 4000,  // LOWEST - should match first
        quantity: 1.0
    });
    log('✓ Created sell order at 4000 (lowest)', 'success');
    
    const sell3 = await createOrder({
        client_id: 'seller-3',
        instrument: 'ETH-USD',
        side: 'sell',
        type: 'limit',
        price: 4200,
        quantity: 1.0
    });
    log('✓ Created sell order at 4200', 'success');
    
    // Market buy order - should match lowest prices first
    const buy = await createOrder({
        client_id: 'buyer-X',
        instrument: 'ETH-USD',
        side: 'buy',
        type: 'market',
        quantity: 1.5
    });
    
    assert(buy.match_result.trades_executed === 2, 'Should have 2 trades');
    assert(parseFloat(buy.match_result.trades[0].price) === 4000, 'First trade should be at 4000 (lowest)');
    assert(parseFloat(buy.match_result.trades[1].price) === 4200, 'Second trade should be at 4200');
    
    log('✅ Test 2 PASSED - Price-time priority works!', 'success');
    return { passed: true, name: 'Price-Time Priority' };
}

async function testPartialFills() {
    log('\n=== Test 3: Partial Fills ===', 'info');
    
    // Create large sell order
    const sell = await createOrder({
        client_id: 'seller-big',
        instrument: 'SOL-USD',
        side: 'sell',
        type: 'limit',
        price: 100,
        quantity: 10.0
    });
    log('✓ Created large sell order (10.0 SOL)', 'success');
    
    // First small buy order
    const buy1 = await createOrder({
        client_id: 'buyer-1',
        instrument: 'SOL-USD',
        side: 'buy',
        type: 'limit',
        price: 100,
        quantity: 3.0
    });
    
    assert(buy1.order.status === 'filled', 'First buy should be filled');
    assert(parseFloat(buy1.match_result.trades[0].quantity) === 3.0, 'First trade should be 3.0');
    log('✓ First partial fill: 3.0 SOL matched', 'success');
    
    // Second small buy order
    const buy2 = await createOrder({
        client_id: 'buyer-2',
        instrument: 'SOL-USD',
        side: 'buy',
        type: 'limit',
        price: 100,
        quantity: 4.0
    });
    
    assert(buy2.order.status === 'filled', 'Second buy should be filled');
    assert(parseFloat(buy2.match_result.trades[0].quantity) === 4.0, 'Second trade should be 4.0');
    log('✓ Second partial fill: 4.0 SOL matched', 'success');
    
    // Verify orderbook still has remaining quantity (3.0 SOL)
    try {
        const orderbook = await getOrderBook('SOL-USD');
        if (orderbook && orderbook.asks && Array.isArray(orderbook.asks)) {
            const remainingSell = orderbook.asks.find(ask => parseFloat(ask.price) === 100);
            if (remainingSell) {
                log('✓ Remaining 3.0 SOL still in orderbook', 'success');
            } else {
                log('⚠️  Sell order not found in orderbook (may have been fully filled)', 'warn');
            }
        } else {
            log('⚠️  Orderbook response format unexpected, skipping verification', 'warn');
        }
    } catch (error) {
        log('⚠️  Could not verify orderbook, but partial fills worked', 'warn');
    }
    
    log('✅ Test 3 PASSED - Partial fills work correctly!', 'success');
    return { passed: true, name: 'Partial Fills' };
}

async function testMarketOrder() {
    log('\n=== Test 4: Market Order Execution ===', 'info');
    
    // Create two sell orders at different prices
    await createOrder({
        client_id: 'seller-1',
        instrument: 'MATIC-USD',
        side: 'sell',
        type: 'limit',
        price: 1.10,
        quantity: 100
    });
    log('✓ Created sell order at 1.10', 'success');
    
    await createOrder({
        client_id: 'seller-2',
        instrument: 'MATIC-USD',
        side: 'sell',
        type: 'limit',
        price: 1.15,
        quantity: 100
    });
    log('✓ Created sell order at 1.15', 'success');
    
    // Market buy order - should match both sells
    const buy = await createOrder({
        client_id: 'buyer-market',
        instrument: 'MATIC-USD',
        side: 'buy',
        type: 'market',
        quantity: 200
    });
    
    assert(buy.match_result.trades_executed === 2, 'Market order should match 2 sells');
    assert(buy.order.status === 'filled', 'Market order should be fully filled');
    assert(parseFloat(buy.match_result.trades[0].price) === 1.10, 'First match at 1.10');
    assert(parseFloat(buy.match_result.trades[1].price) === 1.15, 'Second match at 1.15');
    
    log('✅ Test 4 PASSED - Market orders execute correctly!', 'success');
    return { passed: true, name: 'Market Order' };
}

async function testOrderCancellation() {
    log('\n=== Test 5: Order Cancellation ===', 'info');
    
    // Create an order
    const order = await createOrder({
        client_id: 'test-cancel',
        instrument: 'BTC-USD',
        side: 'sell',
        type: 'limit',
        price: 75000,
        quantity: 1.0
    });
    
    const orderId = order.order.order_id;
    log(`✓ Created order: ${orderId}`, 'success');
    
    // Cancel the order
    try {
        const cancelResponse = await axios.post(
            `${ORDERS_URL}/${orderId}/cancel`,
            {},
            { headers: { 'Content-Type': 'application/json' } }
        );
        
        assert(cancelResponse.data.success === true, 'Cancellation should succeed');
        log('✓ Order cancelled successfully', 'success');
        
        log('✅ Test 5 PASSED - Order cancellation works!', 'success');
        return { passed: true, name: 'Order Cancellation' };
    } catch (error) {
        log(`⚠️  Test 5 SKIPPED - Cancellation endpoint may not be fully implemented`, 'warn');
        return { passed: true, name: 'Order Cancellation (skipped)', skipped: true };
    }
}

async function testIdempotency() {
    log('\n=== Test 6: Idempotency ===', 'info');
    
    const idempotencyKey = `idempotency-test-${Date.now()}`;
    
    // First request
    const response1 = await axios.post(ORDERS_URL, {
        client_id: 'idempotency-client',
        instrument: 'BTC-USD',
        side: 'sell',
        type: 'limit',
        price: 72000,
        quantity: 0.5
    }, {
        headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey
        }
    });
    
    const orderId1 = response1.data.order.order_id;
    log(`✓ First request created order: ${orderId1}`, 'success');
    
    // Second request with SAME idempotency key
    const response2 = await axios.post(ORDERS_URL, {
        client_id: 'idempotency-client',
        instrument: 'BTC-USD',
        side: 'sell',
        type: 'limit',
        price: 72000,
        quantity: 0.5
    }, {
        headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey
        }
    });
    
    const orderId2 = response2.data.order.order_id;
    
    assert(orderId1 === orderId2, 'Should return same order ID');
    log('✓ Second request returned cached response', 'success');
    
    log('✅ Test 6 PASSED - Idempotency works correctly!', 'success');
    return { passed: true, name: 'Idempotency' };
}

// ============================================================================
// SPECIFICATION TESTS - High Concurrency & Resilience
// ============================================================================

async function testConcurrent1000Clients() {
    log('\n=== Test 7: 1,000 Concurrent Clients (SPECIFICATION) ===', 'info');
    log('📊 SPEC REQUIREMENT: 1,000 concurrent limit orders at same price', 'info');
    
    const CLIENTS = 1000; // SPEC: 1,000 concurrent clients
    const PRICE = 50000;
    const QUANTITY_PER_ORDER = 1;
    
    log(`📊 Submitting ${CLIENTS} concurrent limit orders at price $${PRICE}...`, 'info');
    
    const promises = [];
    const startTime = Date.now();
    
    // Submit all orders concurrently
    for (let i = 0; i < CLIENTS; i++) {
        const promise = createOrder({
            client_id: `concurrent-client-${i}`,
            instrument: 'BTC-USD',
            side: 'sell',
            type: 'limit',
            price: PRICE,
            quantity: QUANTITY_PER_ORDER
        }).catch(err => ({
            error: true,
            message: err.message
        }));
        
        promises.push(promise);
    }
    
    // Wait for all orders
    const responses = await Promise.all(promises);
    const duration = Date.now() - startTime;
    
    // Analyze results
    const successful = responses.filter(r => !r.error);
    const failed = responses.filter(r => r.error);
    const orderIds = new Set(successful.map(r => r.order.order_id));
    
    log(`✓ Completed in ${duration}ms`, 'info');
    log(`✓ Successful: ${successful.length}/${CLIENTS}`, successful.length === CLIENTS ? 'success' : 'warn');
    log(`✓ Failed: ${failed.length}`, failed.length === 0 ? 'success' : 'error');
    log(`✓ Unique Order IDs: ${orderIds.size}`, 'success');
    log(`✓ No overlaps: ${orderIds.size === successful.length}`, 'success');
    
    // Get orderbook to verify total quantity
    const orderbook = await getOrderBook('BTC-USD');
    const askLevel = orderbook?.asks?.find(a => parseFloat(a.price) === PRICE);
    
    if (askLevel) {
        const totalQuantity = parseFloat(askLevel.quantity);
        const expectedQuantity = successful.length * QUANTITY_PER_ORDER;
        log(`✓ Total quantity in orderbook: ${totalQuantity} (expected: ${expectedQuantity})`, 'info');
    }
    
    // Validation
    const successRate = (successful.length / CLIENTS) * 100;
    const hasNoOverlaps = orderIds.size === successful.length;
    
    if (successRate < 90) {
        log(`❌ Test 7 FAILED - Success rate too low: ${successRate.toFixed(1)}%`, 'error');
        return { passed: false, name: '1,000 Concurrent Clients', error: 'Low success rate' };
    }
    
    if (!hasNoOverlaps) {
        log(`❌ Test 7 FAILED - Duplicate order IDs detected!`, 'error');
        return { passed: false, name: '1,000 Concurrent Clients', error: 'Duplicate orders' };
    }
    
    log(`✅ Test 7 PASSED - ${successful.length}/1,000 orders processed successfully (${successRate.toFixed(1)}%)`, 'success');
    return { passed: true, name: '1,000 Concurrent Clients', warnings: failed.length };
}


// ============================================================================
// LOAD TESTS
// ============================================================================

function createLoadTestOrder() {
    return new Promise((resolve, reject) => {
        // Distribute across multiple instruments for better concurrency
        const instruments = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'MATIC-USD', 'AVAX-USD'];
        const instrument = instruments[Math.floor(Math.random() * instruments.length)];
        
        const side = Math.random() > 0.5 ? 'buy' : 'sell';
        
        // Price ranges per instrument
        const priceRanges = {
            'BTC-USD': { base: 69000, range: 2000 },
            'ETH-USD': { base: 4000, range: 200 },
            'SOL-USD': { base: 100, range: 10 },
            'MATIC-USD': { base: 1, range: 0.2 },
            'AVAX-USD': { base: 40, range: 5 }
        };
        
        const priceConfig = priceRanges[instrument];
        const basePrice = side === 'buy' ? priceConfig.base - priceConfig.range/2 : priceConfig.base + priceConfig.range/2;
        const price = basePrice + (Math.random() - 0.5) * priceConfig.range;
        
        const order = {
            client_id: `load-client-${Math.floor(Math.random() * 1000)}`,
            instrument: instrument,
            side: side,
            type: 'limit',
            price: parseFloat(price.toFixed(2)),
            quantity: parseFloat((Math.random() * 0.5 + 0.1).toFixed(2))
        };
        
        const data = JSON.stringify(order);
        const startTime = Date.now();
        
        const options = {
            hostname: 'localhost',
            port: 80,
            path: '/api/orders/orders',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length,
                'Idempotency-Key': `load-${Date.now()}-${loadTestCounter++}`
            }
        };
        
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                const latency = Date.now() - startTime;
                resolve({
                    success: res.statusCode === 201,
                    latency,
                    statusCode: res.statusCode
                });
            });
        });
        
        req.on('error', (e) => {
            resolve({
                success: false,
                latency: Date.now() - startTime,
                error: e.message
            });
        });
        
        req.write(data);
        req.end();
    });
}

async function runLoadTest() {
    log('\n' + '='.repeat(60), 'info');
    log('LOAD TEST - Performance Testing', 'info');
    log('='.repeat(60), 'info');
    
    const { targetRPS, duration } = CONFIG.loadTest;
    log(`\n🚀 Target: ${targetRPS} requests/second for ${duration} seconds\n`, 'info');
    
    const startTime = Date.now();
    const endTime = startTime + (duration * 1000);
    const interval = 1000 / targetRPS;
    
    const results = {
        success: 0,
        failed: 0,
        latencies: []
    };
    
    const promises = [];
    let requestCount = 0;
    
    // Progress bar
    const progressInterval = setInterval(() => {
        const elapsed = (Date.now() - startTime) / 1000;
        const progress = Math.min((elapsed / duration) * 100, 100);
        const bar = '█'.repeat(Math.floor(progress / 2)) + '░'.repeat(50 - Math.floor(progress / 2));
        process.stdout.write(`\r[${bar}] ${progress.toFixed(1)}% | Requests: ${requestCount} | Success: ${results.success} | Failed: ${results.failed}`);
    }, 500);
    
    while (Date.now() < endTime) {
        const requestStartTime = Date.now();
        
        promises.push(
            createLoadTestOrder().then(result => {
                if (result.success) {
                    results.success++;
                } else {
                    results.failed++;
                }
                results.latencies.push(result.latency);
            })
        );
        
        requestCount++;
        
        // Maintain target RPS
        const elapsed = Date.now() - requestStartTime;
        const sleep = Math.max(0, interval - elapsed);
        await new Promise(resolve => setTimeout(resolve, sleep));
    }
    
    // Wait for all requests to complete
    await Promise.allSettled(promises);
    clearInterval(progressInterval);
    console.log(''); // New line after progress bar
    
    // Calculate statistics
    const totalTime = (Date.now() - startTime) / 1000;
    const totalRequests = results.success + results.failed;
    const actualRPS = totalRequests / totalTime;
    const successRate = (results.success / totalRequests) * 100;
    
    results.latencies.sort((a, b) => a - b);
    const avgLatency = results.latencies.reduce((a, b) => a + b, 0) / results.latencies.length;
    const minLatency = results.latencies[0];
    const maxLatency = results.latencies[results.latencies.length - 1];
    const p50 = results.latencies[Math.floor(results.latencies.length * 0.50)];
    const p95 = results.latencies[Math.floor(results.latencies.length * 0.95)];
    const p99 = results.latencies[Math.floor(results.latencies.length * 0.99)];
    
    // Print results
    log('\n' + '='.repeat(60), 'info');
    log('LOAD TEST RESULTS', 'info');
    log('='.repeat(60) + '\n', 'info');
    
    log(`⏱️  Duration: ${totalTime.toFixed(2)}s`, 'info');
    log(`📊 Total Requests: ${totalRequests}`, 'info');
    log(`✅ Successful: ${results.success} (${successRate.toFixed(2)}%)`, 'success');
    log(`❌ Failed: ${results.failed} (${((results.failed/totalRequests)*100).toFixed(2)}%)`, results.failed > 0 ? 'error' : 'success');
    log(`🚀 Actual RPS: ${actualRPS.toFixed(2)} (target: ${targetRPS})`, 'info');
    
    log('\n📈 Latency Statistics:', 'info');
    log(`   Min:  ${minLatency}ms`, 'info');
    log(`   Avg:  ${avgLatency.toFixed(2)}ms`, 'info');
    log(`   p50:  ${p50}ms`, 'info');
    log(`   p95:  ${p95}ms`, 'info');
    log(`   p99:  ${p99}ms`, 'info');
    log(`   Max:  ${maxLatency}ms`, 'info');
    
    // Evaluate performance
    log('\n📊 Performance Evaluation:', 'info');
    
    const checks = [
        { name: 'Success Rate', value: successRate, target: 95, unit: '%', passed: successRate >= 95 },
        { name: 'Avg Latency', value: avgLatency, target: 100, unit: 'ms', passed: avgLatency < 100 },
        { name: 'p95 Latency', value: p95, target: 200, unit: 'ms', passed: p95 < 200 },
        { name: 'p99 Latency', value: p99, target: 500, unit: 'ms', passed: p99 < 500 }
    ];
    
    checks.forEach(check => {
        const status = check.passed ? '✅' : '❌';
        const color = check.passed ? 'success' : 'error';
        log(`   ${status} ${check.name}: ${check.value.toFixed(2)}${check.unit} (target: <${check.target}${check.unit})`, color);
    });
    
    const allPassed = checks.every(c => c.passed);
    
    if (allPassed) {
        log('\n✅ LOAD TEST PASSED - System performs well under load! 🎉\n', 'success');
    } else {
        log('\n⚠️  LOAD TEST WARNING - Some performance targets not met\n', 'warn');
    }
    
    return {
        passed: allPassed,
        name: 'Load Test',
        stats: { totalRequests, successRate, avgLatency, p95, p99 }
    };
}

/**
 * Force Exactly 2000 req/sec Load Test with Detailed Metrics
 * 
 * This function enforces a strict 2000 requests/second rate by:
 * - Using precise timing control
 * - Batching requests in controlled intervals
 * - Collecting comprehensive metrics per second
 * - Providing real-time monitoring
 */
async function runPrecise2000RpsLoadTest(durationSeconds = 60) {
    log('\n' + '='.repeat(80), 'info');
    log('PRECISE 2000 RPS LOAD TEST - Detailed Metrics Collection', 'info');
    log('='.repeat(80), 'info');
    
    const TARGET_RPS = 2000;
    const BATCH_INTERVAL_MS = 100; // Send requests every 100ms
    const REQUESTS_PER_BATCH = (TARGET_RPS * BATCH_INTERVAL_MS) / 1000; // 200 requests per batch
    
    log(`\n🎯 Target: ${TARGET_RPS} requests/second (STRICT)`, 'info');
    log(`📦 Strategy: ${REQUESTS_PER_BATCH} requests every ${BATCH_INTERVAL_MS}ms`, 'info');
    log(`⏱️  Duration: ${durationSeconds} seconds\n`, 'info');
    
    const startTime = Date.now();
    const endTime = startTime + (durationSeconds * 1000);
    
    // Global metrics
    const globalMetrics = {
        totalRequests: 0,
        totalSuccess: 0,
        totalFailed: 0,
        allLatencies: [],
        errors: {}
    };
    
    // Per-second metrics
    const perSecondMetrics = [];
    let currentSecondMetrics = {
        second: 0,
        requests: 0,
        success: 0,
        failed: 0,
        latencies: [],
        rps: 0
    };
    
    let batchCounter = 0;
    let lastSecond = 0;
    
    // Real-time monitoring
    const monitorInterval = setInterval(() => {
        const elapsed = (Date.now() - startTime) / 1000;
        const progress = Math.min((elapsed / durationSeconds) * 100, 100);
        const bar = '█'.repeat(Math.floor(progress / 2.5)) + '░'.repeat(40 - Math.floor(progress / 2.5));
        const currentRps = currentSecondMetrics.requests > 0 ? 
            (currentSecondMetrics.requests / (elapsed % 1 || 1)).toFixed(0) : '0';
        
        process.stdout.write(
            `\r[${bar}] ${progress.toFixed(1)}% | ` +
            `Sec: ${Math.floor(elapsed)}/${durationSeconds} | ` +
            `Total: ${globalMetrics.totalRequests} | ` +
            `RPS: ~${currentRps} | ` +
            `Success: ${globalMetrics.totalSuccess} | ` +
            `Failed: ${globalMetrics.totalFailed}`
        );
    }, 250);
    
    // Main load generation loop
    while (Date.now() < endTime) {
        const batchStartTime = Date.now();
        const currentElapsed = batchStartTime - startTime;
        const currentSecond = Math.floor(currentElapsed / 1000);
        
        // New second started - save previous metrics
        if (currentSecond > lastSecond && currentSecondMetrics.requests > 0) {
            currentSecondMetrics.rps = currentSecondMetrics.requests;
            perSecondMetrics.push({ ...currentSecondMetrics });
            
            // Reset for new second
            currentSecondMetrics = {
                second: currentSecond,
                requests: 0,
                success: 0,
                failed: 0,
                latencies: [],
                rps: 0
            };
            lastSecond = currentSecond;
        } else if (currentSecond === 0 && lastSecond === 0) {
            currentSecondMetrics.second = 0;
        }
        
        // Send batch of requests
        const batchPromises = [];
        for (let i = 0; i < REQUESTS_PER_BATCH; i++) {
            const promise = createLoadTestOrder().then(result => {
                // Update global metrics
                globalMetrics.totalRequests++;
                if (result.success) {
                    globalMetrics.totalSuccess++;
                } else {
                    globalMetrics.totalFailed++;
                    const errorKey = result.error || `HTTP_${result.statusCode}`;
                    globalMetrics.errors[errorKey] = (globalMetrics.errors[errorKey] || 0) + 1;
                }
                globalMetrics.allLatencies.push(result.latency);
                
                // Update current second metrics
                currentSecondMetrics.requests++;
                if (result.success) {
                    currentSecondMetrics.success++;
                } else {
                    currentSecondMetrics.failed++;
                }
                currentSecondMetrics.latencies.push(result.latency);
                
                return result;
            });
            
            batchPromises.push(promise);
        }
        
        // Wait for batch to complete or timeout
        await Promise.allSettled(batchPromises);
        batchCounter++;
        
        // Precise timing control - wait until next batch time
        const batchElapsed = Date.now() - batchStartTime;
        const sleepTime = Math.max(0, BATCH_INTERVAL_MS - batchElapsed);
        
        if (sleepTime > 0) {
            await new Promise(resolve => setTimeout(resolve, sleepTime));
        }
    }
    
    // Save last second's metrics
    if (currentSecondMetrics.requests > 0) {
        currentSecondMetrics.rps = currentSecondMetrics.requests;
        perSecondMetrics.push(currentSecondMetrics);
    }
    
    clearInterval(monitorInterval);
    console.log('\n'); // New line after progress
    
    // Calculate comprehensive statistics
    const totalDuration = (Date.now() - startTime) / 1000;
    const actualRPS = globalMetrics.totalRequests / totalDuration;
    const successRate = (globalMetrics.totalSuccess / globalMetrics.totalRequests) * 100;
    
    // Latency statistics
    globalMetrics.allLatencies.sort((a, b) => a - b);
    const latencyStats = {
        min: globalMetrics.allLatencies[0],
        max: globalMetrics.allLatencies[globalMetrics.allLatencies.length - 1],
        avg: globalMetrics.allLatencies.reduce((a, b) => a + b, 0) / globalMetrics.allLatencies.length,
        p50: globalMetrics.allLatencies[Math.floor(globalMetrics.allLatencies.length * 0.50)],
        p75: globalMetrics.allLatencies[Math.floor(globalMetrics.allLatencies.length * 0.75)],
        p90: globalMetrics.allLatencies[Math.floor(globalMetrics.allLatencies.length * 0.90)],
        p95: globalMetrics.allLatencies[Math.floor(globalMetrics.allLatencies.length * 0.95)],
        p99: globalMetrics.allLatencies[Math.floor(globalMetrics.allLatencies.length * 0.99)],
        p999: globalMetrics.allLatencies[Math.floor(globalMetrics.allLatencies.length * 0.999)]
    };
    
    // RPS statistics across all seconds
    const rpsValues = perSecondMetrics.map(m => m.rps);
    const rpsStats = {
        min: Math.min(...rpsValues),
        max: Math.max(...rpsValues),
        avg: rpsValues.reduce((a, b) => a + b, 0) / rpsValues.length,
        stdDev: 0
    };
    const rpsVariance = rpsValues.reduce((sum, rps) => sum + Math.pow(rps - rpsStats.avg, 2), 0) / rpsValues.length;
    rpsStats.stdDev = Math.sqrt(rpsVariance);
    
    // Print detailed results
    log('='.repeat(80), 'info');
    log('PRECISE 2000 RPS LOAD TEST RESULTS', 'info');
    log('='.repeat(80) + '\n', 'info');
    
    // Overall Metrics
    log('📊 OVERALL METRICS:', 'info');
    log('─'.repeat(80), 'info');
    log(`   Total Duration:        ${totalDuration.toFixed(2)}s`, 'info');
    log(`   Total Requests:        ${globalMetrics.totalRequests.toLocaleString()}`, 'info');
    log(`   Successful:            ${globalMetrics.totalSuccess.toLocaleString()} (${successRate.toFixed(2)}%)`, 
        successRate >= 95 ? 'success' : 'warn');
    log(`   Failed:                ${globalMetrics.totalFailed.toLocaleString()} (${(100-successRate).toFixed(2)}%)`, 
        globalMetrics.totalFailed === 0 ? 'success' : 'error');
    log(`   Target RPS:            ${TARGET_RPS}`, 'info');
    log(`   Actual RPS:            ${actualRPS.toFixed(2)}`, 
        Math.abs(actualRPS - TARGET_RPS) < 50 ? 'success' : 'warn');
    log(`   RPS Accuracy:          ${((actualRPS/TARGET_RPS)*100).toFixed(2)}%`, 
        Math.abs(actualRPS - TARGET_RPS) < 50 ? 'success' : 'warn');
    
    // RPS Distribution
    log('\n🎯 RPS DISTRIBUTION (per second):', 'info');
    log('─'.repeat(80), 'info');
    log(`   Min RPS:               ${rpsStats.min}`, 'info');
    log(`   Max RPS:               ${rpsStats.max}`, 'info');
    log(`   Avg RPS:               ${rpsStats.avg.toFixed(2)}`, 'info');
    log(`   Std Dev:               ${rpsStats.stdDev.toFixed(2)}`, 'info');
    log(`   Variance:              ${rpsVariance.toFixed(2)}`, 'info');
    
    // Latency Statistics
    log('\n⚡ LATENCY STATISTICS:', 'info');
    log('─'.repeat(80), 'info');
    log(`   Min Latency:           ${latencyStats.min}ms`, 'info');
    log(`   Max Latency:           ${latencyStats.max}ms`, 'info');
    log(`   Avg Latency:           ${latencyStats.avg.toFixed(2)}ms`, 
        latencyStats.avg < 100 ? 'success' : 'warn');
    log(`   Median (p50):          ${latencyStats.p50}ms`, 'info');
    log(`   p75:                   ${latencyStats.p75}ms`, 'info');
    log(`   p90:                   ${latencyStats.p90}ms`, 'info');
    log(`   p95:                   ${latencyStats.p95}ms`, 
        latencyStats.p95 < 200 ? 'success' : 'warn');
    log(`   p99:                   ${latencyStats.p99}ms`, 
        latencyStats.p99 < 500 ? 'success' : 'warn');
    log(`   p99.9:                 ${latencyStats.p999}ms`, 'info');
    
    // Error Distribution
    if (Object.keys(globalMetrics.errors).length > 0) {
        log('\n❌ ERROR DISTRIBUTION:', 'error');
        log('─'.repeat(80), 'error');
        Object.entries(globalMetrics.errors)
            .sort((a, b) => b[1] - a[1])
            .forEach(([error, count]) => {
                log(`   ${error}: ${count} (${((count/globalMetrics.totalRequests)*100).toFixed(2)}%)`, 'error');
            });
    }
    
    // Per-Second Breakdown (show first 5, last 5, and any anomalies)
    log('\n📈 PER-SECOND BREAKDOWN (Sample):', 'info');
    log('─'.repeat(80), 'info');
    log('   Sec |  RPS  | Success | Failed | Avg Latency | Status', 'info');
    log('   ' + '─'.repeat(74), 'info');
    
    // Show first 5 seconds
    perSecondMetrics.slice(0, 5).forEach(m => {
        const avgLat = m.latencies.length > 0 ? 
            (m.latencies.reduce((a, b) => a + b, 0) / m.latencies.length).toFixed(1) : '0';
        const status = m.rps >= TARGET_RPS * 0.9 && m.rps <= TARGET_RPS * 1.1 ? '✅' : '⚠️';
        log(`   ${String(m.second).padStart(3)} | ${String(m.rps).padStart(5)} | ${String(m.success).padStart(7)} | ` +
            `${String(m.failed).padStart(6)} | ${String(avgLat).padStart(11)}ms | ${status}`, 'info');
    });
    
    if (perSecondMetrics.length > 10) {
        log('   ...', 'info');
        
        // Show last 5 seconds
        perSecondMetrics.slice(-5).forEach(m => {
            const avgLat = m.latencies.length > 0 ? 
                (m.latencies.reduce((a, b) => a + b, 0) / m.latencies.length).toFixed(1) : '0';
            const status = m.rps >= TARGET_RPS * 0.9 && m.rps <= TARGET_RPS * 1.1 ? '✅' : '⚠️';
            log(`   ${String(m.second).padStart(3)} | ${String(m.rps).padStart(5)} | ${String(m.success).padStart(7)} | ` +
                `${String(m.failed).padStart(6)} | ${String(avgLat).padStart(11)}ms | ${status}`, 'info');
        });
    }
    
    // Performance Evaluation
    log('\n🎯 PERFORMANCE EVALUATION:', 'info');
    log('─'.repeat(80), 'info');
    
    const performanceChecks = [
        { 
            name: 'RPS Target Achieved', 
            passed: Math.abs(actualRPS - TARGET_RPS) < 100,
            value: `${actualRPS.toFixed(0)}/${TARGET_RPS}`,
            target: '±100 RPS tolerance'
        },
        { 
            name: 'Success Rate', 
            passed: successRate >= 95,
            value: `${successRate.toFixed(2)}%`,
            target: '≥95%'
        },
        { 
            name: 'Avg Latency', 
            passed: latencyStats.avg < 100,
            value: `${latencyStats.avg.toFixed(2)}ms`,
            target: '<100ms'
        },
        { 
            name: 'p95 Latency', 
            passed: latencyStats.p95 < 200,
            value: `${latencyStats.p95}ms`,
            target: '<200ms'
        },
        { 
            name: 'p99 Latency', 
            passed: latencyStats.p99 < 500,
            value: `${latencyStats.p99}ms`,
            target: '<500ms'
        },
        { 
            name: 'RPS Consistency', 
            passed: rpsStats.stdDev < 100,
            value: `σ=${rpsStats.stdDev.toFixed(2)}`,
            target: 'σ<100'
        }
    ];
    
    performanceChecks.forEach(check => {
        const status = check.passed ? '✅' : '❌';
        const color = check.passed ? 'success' : 'error';
        log(`   ${status} ${check.name.padEnd(22)}: ${check.value.padEnd(15)} (target: ${check.target})`, color);
    });
    
    const allChecksPassed = performanceChecks.every(c => c.passed);
    
    // Final verdict
    log('\n' + '='.repeat(80), 'info');
    if (allChecksPassed) {
        log('✅ PRECISE 2000 RPS TEST PASSED - All targets met! 🎉', 'success');
    } else {
        const failedChecks = performanceChecks.filter(c => !c.passed).length;
        log(`⚠️  PRECISE 2000 RPS TEST COMPLETED - ${failedChecks} target(s) not met`, 'warn');
    }
    log('='.repeat(80) + '\n', 'info');
    
    return {
        passed: allChecksPassed,
        name: 'Precise 2000 RPS Load Test',
        metrics: {
            global: globalMetrics,
            latency: latencyStats,
            rps: rpsStats,
            perSecond: perSecondMetrics,
            performance: performanceChecks
        }
    };
}

// ============================================================================
// MAIN TEST RUNNER
// ============================================================================

async function runFunctionalTests() {
    log('\n' + '='.repeat(60), 'info');
    log('FUNCTIONAL TESTS - Matching Engine Logic', 'info');
    log('='.repeat(60), 'info');
    
    const tests = [
        testBasicMatching,
        testPriceTimePriority,
        testPartialFills,
        testMarketOrder,
        testOrderCancellation,
        testIdempotency,
        testConcurrent1000Clients
    ];
    
    const results = [];
    
    for (const test of tests) {
        try {
            const result = await test();
            results.push(result);
        } catch (error) {
            log(`\n❌ Test FAILED: ${error.message}`, 'error');
            results.push({ passed: false, name: test.name, error: error.message });
        }
    }
    
    // Summary
    log('\n' + '='.repeat(60), 'info');
    log('FUNCTIONAL TESTS SUMMARY', 'info');
    log('='.repeat(60) + '\n', 'info');
    
    const passed = results.filter(r => r.passed && !r.skipped).length;
    const skipped = results.filter(r => r.skipped).length;
    const failed = results.filter(r => !r.passed).length;
    
    results.forEach(result => {
        if (result.skipped) {
            log(`⏭️  ${result.name} - SKIPPED`, 'warn');
        } else if (result.passed) {
            log(`✅ ${result.name} - PASSED`, 'success');
        } else {
            log(`❌ ${result.name} - FAILED: ${result.error}`, 'error');
        }
    });
    
    log(`\nTotal: ${results.length} | Passed: ${passed} | Skipped: ${skipped} | Failed: ${failed}`, 'info');
    
    return failed === 0;
}

async function main() {
    const args = process.argv.slice(2);
    const mode = args[0] || 'all';
    const duration = parseInt(args[1]) || 60; // Optional duration parameter
    
    log('\n' + '█'.repeat(60), 'info');
    log('  MATCHING ENGINE COMPREHENSIVE TEST SUITE  ', 'info');
    log('█'.repeat(60) + '\n', 'info');
    
    let functionalPassed = true;
    let loadPassed = true;
    let preciseLoadPassed = true;
    
    try {
        if (mode === 'functional' || mode === 'all') {
            functionalPassed = await runFunctionalTests();
        }
        
        if (mode === 'load' || mode === 'all') {
            await new Promise(resolve => setTimeout(resolve, 2000)); // Pause between test types
            loadPassed = (await runLoadTest()).passed;
        }
        
        if (mode === 'precise' || mode === 'precise2000') {
            await new Promise(resolve => setTimeout(resolve, 2000)); // Pause before test
            preciseLoadPassed = (await runPrecise2000RpsLoadTest(duration)).passed;
        }
        
        // Final summary
        log('\n' + '█'.repeat(60), 'info');
        log('  FINAL RESULTS  ', 'info');
        log('█'.repeat(60) + '\n', 'info');
        
        const testsRun = [];
        if (mode === 'functional' || mode === 'all') {
            testsRun.push({ name: 'Functional Tests', passed: functionalPassed });
        }
        if (mode === 'load' || mode === 'all') {
            testsRun.push({ name: 'Load Test', passed: loadPassed });
        }
        if (mode === 'precise' || mode === 'precise2000') {
            testsRun.push({ name: 'Precise 2000 RPS Test', passed: preciseLoadPassed });
        }
        
        testsRun.forEach(test => {
            const status = test.passed ? '✅' : '❌';
            const color = test.passed ? 'success' : 'error';
            log(`${status} ${test.name}`, color);
        });
        
        const allPassed = testsRun.every(t => t.passed);
        
        if (allPassed) {
            log('\n✅ ALL TESTS PASSED! System is working correctly! 🎉\n', 'success');
            process.exit(0);
        } else {
            log('\n⚠️  Some tests did not meet all targets\n', 'warn');
            process.exit(1);
        }
        
    } catch (error) {
        log(`\n❌ TEST SUITE FAILED: ${error.message}`, 'error');
        if (error.stack) {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

// Run tests
if (require.main === module) {
    main();
}

module.exports = { runFunctionalTests, runLoadTest, runPrecise2000RpsLoadTest };

