/**
 * Integration Tests for Matching Engine with Database
 * Tests matching logic with mocked DB operations
 */

const MatchingEngine = require('../../helper/matcher');
const { createMockRedisService, createTestOrder, createTestTrade } = require('../helpers');

// Mock the DB module
jest.mock('../../db/query', () => ({
    DB: {
        init: jest.fn(),
        find: jest.fn().mockResolvedValue([]),
        find_one: jest.fn().mockResolvedValue(null),
        insert: jest.fn().mockResolvedValue({ success: true }),
        update: jest.fn().mockResolvedValue({ success: true })
    }
}));

const { DB } = require('../../db/query');

describe('MatchingEngine - Database Integration', () => {
    let engine;
    let mockRedisService;
    let mockPool;

    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisService = createMockRedisService();
        mockPool = {
            query: jest.fn().mockResolvedValue([{ affectedRows: 1 }]),
            execute: jest.fn().mockResolvedValue([{ affectedRows: 1 }])
        };
        engine = new MatchingEngine(mockPool, mockRedisService);
    });

    describe('Order Cancellation with DB', () => {
        test('should cancel open order and update database', async () => {
            const orderId = 'test-order-1';
            const orderToCancel = {
                order_id: orderId,
                instrument: 'BTC-USD',
                side: 'buy',
                status: 'open',
                created_at: new Date(),
                filled_quantity: 0
            };

            DB.find_one.mockResolvedValueOnce(orderToCancel);

            const result = await engine.cancelOrder(orderId);

            expect(result.success).toBe(true);
            expect(DB.update).toHaveBeenCalled();
            expect(mockRedisService.removeOrderFromBook).toHaveBeenCalledWith(
                'BTC-USD',
                'buy',
                orderId,
                expect.any(Number)
            );
        });

        test('should not cancel filled order', async () => {
            const filledOrder = {
                order_id: 'filled-order',
                status: 'filled'
            };

            DB.find_one.mockResolvedValueOnce(filledOrder);

            await expect(engine.cancelOrder('filled-order')).rejects.toThrow(
                'Cannot cancel order that is already filled or cancelled'
            );
        });

        test('should not cancel already cancelled order', async () => {
            const cancelledOrder = {
                order_id: 'cancelled-order',
                status: 'cancelled'
            };

            DB.find_one.mockResolvedValueOnce(cancelledOrder);

            await expect(engine.cancelOrder('cancelled-order')).rejects.toThrow(
                'Cannot cancel order that is already filled or cancelled'
            );
        });
    });

    describe('Persistence - Trade Recording', () => {
        test('should persist matched trades to database', async () => {
            const trade = createTestTrade();
            const order = createTestOrder();

            const matchResult = {
                trades: [trade],
                orderUpdates: [],
                bookUpdates: []
            };

            DB.insert.mockResolvedValueOnce({ success: true });

            await engine._persistMatchResult(matchResult, order);

            expect(DB.insert).toHaveBeenCalledWith(
                'trades',
                expect.objectContaining({
                    trade_id: trade.trade_id,
                    buy_order_id: trade.buy_order_id,
                    sell_order_id: trade.sell_order_id,
                    instrument: trade.instrument,
                    price: expect.any(String),
                    quantity: expect.any(String)
                })
            );
        });

        test('should update order status in database after matching', async () => {
            const order = createTestOrder({
                filled_quantity: 0.5,
                status: 'partially_filled'
            });

            const matchResult = {
                trades: [],
                orderUpdates: [order],
                bookUpdates: []
            };

            DB.update.mockResolvedValueOnce({ success: true });

            await engine._persistMatchResult(matchResult, order);

            expect(DB.update).toHaveBeenCalledWith(
                'orders',
                expect.objectContaining({
                    filled_quantity: expect.stringContaining('0.5'),
                    status: 'partially_filled'
                }),
                expect.any(Object)
            );
        });
    });

    describe('Initialization from Database', () => {
        test('should load open orders from database on init', async () => {
            const orders = [
                createTestOrder({ status: 'open' }),
                createTestOrder({ status: 'partially_filled', filled_quantity: 0.3 })
            ];

            DB.find
                .mockResolvedValueOnce(orders.slice(0, 1)) // open orders
                .mockResolvedValueOnce(orders.slice(1));   // partially_filled orders

            await engine.initialize();

            expect(DB.find).toHaveBeenCalledWith('orders', { status: 'open' });
            expect(DB.find).toHaveBeenCalledWith('orders', { status: 'partially_filled' });
            expect(mockRedisService.addOrderToBook).toHaveBeenCalledTimes(2);
        });

        test('should log initialization statistics', async () => {
            const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
            
            DB.find
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            await engine.initialize();

            expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('✅ Matching engine initialized'));
            
            consoleLogSpy.mockRestore();
        });
    });

    describe('Error Handling', () => {
        test('should handle database errors gracefully', async () => {
            DB.find.mockRejectedValueOnce(new Error('DB Connection failed'));

            await expect(engine.initialize()).rejects.toThrow('DB Connection failed');
        });

        test('should handle redis errors gracefully', async () => {
            mockRedisService.addOrderToBook.mockRejectedValueOnce(
                new Error('Redis connection failed')
            );

            DB.find
                .mockResolvedValueOnce([createTestOrder()])
                .mockResolvedValueOnce([]);

            await expect(engine.initialize()).rejects.toThrow('Redis connection failed');
        });

        test('should throw error if order not found for cancellation', async () => {
            DB.find_one.mockResolvedValueOnce(null);

            await expect(engine.cancelOrder('non-existent')).rejects.toThrow('Order not found');
        });
    });

    describe('Metrics Recording', () => {
        test('should increment trade counter on successful match', async () => {
            const order = createTestOrder();
            const matchResult = {
                trades: [createTestTrade(), createTestTrade()],
                orderUpdates: [],
                bookUpdates: []
            };

            DB.insert.mockResolvedValue({ success: true });

            await engine._persistMatchResult(matchResult, order);

            expect(mockRedisService.incrementMetric).toHaveBeenCalledWith(
                'trades:BTC-USD',
                2
            );
            expect(mockRedisService.incrementMetric).toHaveBeenCalledWith(
                'trades:total',
                2
            );
        });

        test('should increment cancel counter on order cancellation', async () => {
            const orderToCancel = createTestOrder({ status: 'open' });
            DB.find_one.mockResolvedValueOnce(orderToCancel);

            await engine.cancelOrder('test-order');

            expect(mockRedisService.incrementMetric).toHaveBeenCalledWith('orders:cancelled');
        });
    });
});
