/**
 * Test Utilities & Helpers
 * Shared functions for unit and integration tests
 */

/**
 * Create a mock Redis service
 */
function createMockRedisService() {
    return {
        redis: {
            set: jest.fn().mockResolvedValue(true),
            get: jest.fn().mockResolvedValue(null),
            del: jest.fn().mockResolvedValue(1),
            setEx: jest.fn().mockResolvedValue(true),
            hSet: jest.fn().mockResolvedValue(1),
            hGetAll: jest.fn().mockResolvedValue({}),
            hGet: jest.fn().mockResolvedValue(null),
            ping: jest.fn().mockResolvedValue('PONG')
        },
        storeOrderDetails: jest.fn().mockResolvedValue(true),
        getOrderDetails: jest.fn().mockResolvedValue(null),
        addOrderToBook: jest.fn().mockResolvedValue(true),
        removeOrderFromBook: jest.fn().mockResolvedValue(true),
        getTopOrders: jest.fn().mockResolvedValue([]),
        getOrderBook: jest.fn().mockResolvedValue({ bids: [], asks: [] }),
        updateOrderStatus: jest.fn().mockResolvedValue(true),
        incrementMetric: jest.fn().mockResolvedValue(true),
        addRecentTrade: jest.fn().mockResolvedValue(true),
        getRecentTrades: jest.fn().mockResolvedValue([]),
        healthCheck: jest.fn().mockResolvedValue({ healthy: true })
    };
}

/**
 * Create a mock database pool
 */
function createMockPool() {
    return {
        query: jest.fn().mockResolvedValue([[]]),
        execute: jest.fn().mockResolvedValue([[]]),
        end: jest.fn().mockResolvedValue(undefined)
    };
}

/**
 * Create a test order
 */
function createTestOrder(overrides = {}) {
    return {
        order_id: 'test-order-' + Math.random().toString(36).substr(2, 9),
        client_id: 'test-client-1',
        instrument: 'BTC-USD',
        side: 'buy',
        type: 'limit',
        price: 70000,
        quantity: 1,
        filled_quantity: 0,
        status: 'open',
        created_at: new Date(),
        updated_at: new Date(),
        ...overrides
    };
}

/**
 * Create a test trade
 */
function createTestTrade(overrides = {}) {
    const { randomUUID } = require('crypto');
    return {
        trade_id: randomUUID(),
        buy_order_id: 'buy-order-1',
        sell_order_id: 'sell-order-1',
        instrument: 'BTC-USD',
        price: 70000,
        quantity: 1,
        buy_client_id: 'client-1',
        sell_client_id: 'client-2',
        executed_at: new Date(),
        ...overrides
    };
}

/**
 * Wait for a condition to be true
 */
async function waitFor(condition, timeout = 1000, interval = 50) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        if (condition()) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, interval));
    }
    throw new Error(`Condition not met within ${timeout}ms`);
}

/**
 * Assert that a value matches a pattern
 */
function assertMatches(value, pattern) {
    if (typeof pattern === 'object' && !Array.isArray(pattern)) {
        Object.keys(pattern).forEach(key => {
            if (pattern[key] instanceof RegExp) {
                expect(value[key]).toMatch(pattern[key]);
            } else {
                expect(value[key]).toEqual(pattern[key]);
            }
        });
    } else {
        expect(value).toEqual(pattern);
    }
}

module.exports = {
    createMockRedisService,
    createMockPool,
    createTestOrder,
    createTestTrade,
    waitFor,
    assertMatches
};
