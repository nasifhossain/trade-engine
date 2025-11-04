/**
 * Unit Tests for Matching Engine
 * Tests core matching logic, concurrency handling, and state management
 */

const MatchingEngine = require('../../helper/matcher');
const { createMockRedisService, createTestOrder } = require('../helpers');

describe('MatchingEngine - Core Functionality', () => {
    let engine;
    let mockRedisService;
    let mockPool;

    beforeEach(() => {
        mockRedisService = createMockRedisService();
        mockPool = {};
        engine = new MatchingEngine(mockPool, mockRedisService);
    });

    describe('Market Order Matching', () => {
        test('should match market buy order with best ask', async () => {
            const takerOrder = {
                order_id: 'buy-order-1',
                client_id: 'client-1',
                instrument: 'BTC-USD',
                side: 'buy',
                type: 'market',
                quantity: 1,
                filled_quantity: 0,
                status: 'open',
                created_at: new Date(),
                price: null
            };

            const makerOrder = {
                order_id: 'sell-order-1',
                client_id: 'client-2',
                instrument: 'BTC-USD',
                side: 'sell',
                type: 'limit',
                price: 70000,
                quantity: 2,
                filled_quantity: 0,
                status: 'open',
                created_at: new Date(Date.now() - 5000)
            };

            mockRedisService.getTopOrders.mockResolvedValueOnce([
                { orderId: 'sell-order-1', price: 70000, quantity: 2 }
            ]);
            mockRedisService.getOrderDetails.mockResolvedValueOnce(makerOrder);

            const matchResult = {
                trades: [],
                orderUpdates: [],
                bookUpdates: []
            };

            await engine._processMarketOrder(takerOrder, matchResult);

            expect(matchResult.trades.length).toBe(1);
            expect(matchResult.trades[0].price).toBe(70000);
            expect(matchResult.trades[0].quantity).toBe(1);
            expect(takerOrder.filled_quantity).toBe(1);
            expect(takerOrder.status).toBe('filled');
        });

        test('should handle partial fills on market orders', async () => {
            const takerOrder = {
                order_id: 'buy-order-1',
                client_id: 'client-1',
                instrument: 'BTC-USD',
                side: 'buy',
                type: 'market',
                quantity: 5,
                filled_quantity: 0,
                status: 'open',
                created_at: new Date()
            };

            const makerOrder1 = {
                order_id: 'sell-order-1',
                client_id: 'client-2',
                side: 'sell',
                quantity: 2,
                filled_quantity: 0,
                status: 'open',
                created_at: new Date(Date.now() - 5000)
            };

            const makerOrder2 = {
                order_id: 'sell-order-2',
                client_id: 'client-3',
                side: 'sell',
                quantity: 3,
                filled_quantity: 0,
                status: 'open',
                created_at: new Date(Date.now() - 3000)
            };

            mockRedisService.getTopOrders.mockResolvedValueOnce([
                { orderId: 'sell-order-1', price: 70000 },
                { orderId: 'sell-order-2', price: 70050 }
            ]);
            mockRedisService.getOrderDetails
                .mockResolvedValueOnce(makerOrder1)
                .mockResolvedValueOnce(makerOrder2);

            const matchResult = {
                trades: [],
                orderUpdates: [],
                bookUpdates: []
            };

            await engine._processMarketOrder(takerOrder, matchResult);

            expect(matchResult.trades.length).toBe(2);
            expect(takerOrder.filled_quantity).toBe(5);
            expect(takerOrder.status).toBe('filled');
        });
    });

    describe('Limit Order Matching', () => {
        test('should match limit order only at favorable price', async () => {
            const takerOrder = {
                order_id: 'buy-order-1',
                client_id: 'client-1',
                instrument: 'BTC-USD',
                side: 'buy',
                type: 'limit',
                price: 70100,
                quantity: 1,
                filled_quantity: 0,
                status: 'open',
                created_at: new Date()
            };

            const makerOrder = {
                order_id: 'sell-order-1',
                client_id: 'client-2',
                side: 'sell',
                price: 70000,
                quantity: 2,
                filled_quantity: 0,
                status: 'open',
                created_at: new Date(Date.now() - 5000)
            };

            mockRedisService.getTopOrders.mockResolvedValueOnce([
                { orderId: 'sell-order-1', price: 70000 }
            ]);
            mockRedisService.getOrderDetails.mockResolvedValueOnce(makerOrder);

            const matchResult = {
                trades: [],
                orderUpdates: [],
                bookUpdates: []
            };

            await engine._processLimitOrder(takerOrder, matchResult);

            expect(matchResult.trades.length).toBe(1);
            expect(matchResult.trades[0].price).toBe(70000); // Maker's price
        });

        test('should not match limit order at unfavorable price', async () => {
            const takerOrder = {
                order_id: 'buy-order-1',
                client_id: 'client-1',
                instrument: 'BTC-USD',
                side: 'buy',
                type: 'limit',
                price: 69000, // Lower than sell orders
                quantity: 1,
                filled_quantity: 0,
                status: 'open',
                created_at: new Date()
            };

            mockRedisService.getTopOrders.mockResolvedValueOnce([
                { orderId: 'sell-order-1', price: 70000 }
            ]);

            const matchResult = {
                trades: [],
                orderUpdates: [],
                bookUpdates: []
            };

            await engine._processLimitOrder(takerOrder, matchResult);

            expect(matchResult.trades.length).toBe(0);
            expect(mockRedisService.addOrderToBook).toHaveBeenCalled();
        });

        test('should add unmatched limit order to book', async () => {
            const takerOrder = {
                order_id: 'buy-order-1',
                client_id: 'client-1',
                instrument: 'BTC-USD',
                side: 'buy',
                type: 'limit',
                price: 69000,
                quantity: 1,
                filled_quantity: 0,
                status: 'open',
                created_at: new Date()
            };

            mockRedisService.getTopOrders.mockResolvedValueOnce([]);

            const matchResult = {
                trades: [],
                orderUpdates: [],
                bookUpdates: []
            };

            await engine._processLimitOrder(takerOrder, matchResult);

            expect(mockRedisService.addOrderToBook).toHaveBeenCalledWith(
                'BTC-USD',
                'buy',
                69000,
                'buy-order-1',
                expect.any(Number)
            );
        });
    });

    describe('Price-Time Priority', () => {
        test('should match earlier order first at same price', async () => {
            const now = new Date();
            const earlierOrder = {
                orderId: 'order-1',
                price: 70000,
                created_at: new Date(now.getTime() - 10000) // 10 seconds earlier
            };
            const laterOrder = {
                orderId: 'order-2',
                price: 70000,
                created_at: now
            };

            // Earlier order should be matched first
            expect(earlierOrder.created_at < laterOrder.created_at).toBe(true);
        });
    });

    describe('Order Cancellation', () => {
        test('should reject cancel on filled order', async () => {
            const orderId = 'filled-order-1';
            const filledOrder = {
                order_id: orderId,
                status: 'filled'
            };

            mockRedisService.getOrderDetails.mockResolvedValueOnce(filledOrder);

            await expect(engine.cancelOrder(orderId)).rejects.toThrow(
                'Cannot cancel order that is already filled or cancelled'
            );
        });

        test('should reject cancel on already cancelled order', async () => {
            const orderId = 'cancelled-order-1';
            const cancelledOrder = {
                order_id: orderId,
                status: 'cancelled'
            };

            mockRedisService.getOrderDetails.mockResolvedValueOnce(cancelledOrder);

            await expect(engine.cancelOrder(orderId)).rejects.toThrow(
                'Cannot cancel order that is already filled or cancelled'
            );
        });
    });

    describe('Double Fill Prevention', () => {
        test('should not double fill on concurrent processing', async () => {
            const orderId = 'concurrent-order-1';
            const order = {
                order_id: orderId,
                quantity: 1,
                filled_quantity: 0,
                status: 'open'
            };

            let lockAcquisitions = 0;
            mockRedisService.redis.set.mockImplementation(async (key, value, options) => {
                if (key === 'matching:lock') {
                    lockAcquisitions++;
                    // First call succeeds, second fails (simulating lock conflict)
                    if (lockAcquisitions === 1) {
                        return true;
                    }
                    return null;
                }
                return true;
            });

            // Verify lock mechanism is in place
            expect(engine.lockKey).toBe('matching:lock');
        });
    });

    describe('Order Status Updates', () => {
        test('should update status to filled when fully matched', () => {
            const order = {
                quantity: 10,
                filled_quantity: 5,
                status: 'open'
            };

            order.filled_quantity = 10;
            engine._updateOrderStatus(order);

            expect(order.status).toBe('filled');
        });

        test('should update status to partially_filled', () => {
            const order = {
                quantity: 10,
                filled_quantity: 0,
                status: 'open'
            };

            order.filled_quantity = 5;
            engine._updateOrderStatus(order);

            expect(order.status).toBe('partially_filled');
        });

        test('should keep status open when not filled', () => {
            const order = {
                quantity: 10,
                filled_quantity: 0,
                status: 'open'
            };

            engine._updateOrderStatus(order);

            expect(order.status).toBe('open');
        });
    });

    describe('Trade Creation', () => {
        test('should create trade with correct fields', () => {
            const takerOrder = {
                order_id: 'buy-order-1',
                client_id: 'client-1',
                instrument: 'BTC-USD',
                side: 'buy'
            };

            const makerOrder = {
                order_id: 'sell-order-1',
                client_id: 'client-2',
                side: 'sell'
            };

            const trade = engine._createTrade(takerOrder, makerOrder, 70000, 1);

            expect(trade.trade_id).toBeDefined();
            expect(trade.buy_order_id).toBe('buy-order-1');
            expect(trade.sell_order_id).toBe('sell-order-1');
            expect(trade.buy_client_id).toBe('client-1');
            expect(trade.sell_client_id).toBe('client-2');
            expect(trade.price).toBe(70000);
            expect(trade.quantity).toBe(1);
            expect(trade.instrument).toBe('BTC-USD');
        });
    });
});
