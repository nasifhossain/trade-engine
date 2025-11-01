const Algo = require('../algo.services');

describe('Algo Trading Engine', () => {
    let algo;

    beforeEach(() => {
        algo = new Algo();
    });

    describe('Order Book Initialization', () => {
        test('should initialize with empty order book', () => {
            const orderBook = algo.getOrderBook();
            expect(orderBook.bids).toEqual([]);
            expect(orderBook.asks).toEqual([]);
        });

        test('should initialize with empty trades', () => {
            expect(algo.getTrades()).toEqual([]);
        });
    });

    describe('Adding Orders', () => {
        test('should add a buy order', () => {
            const order = algo.addBuyOrder(100, 10, 'user1');
            expect(order.type).toBe('BUY');
            expect(order.price).toBe(100);
            expect(order.quantity).toBe(10);
            expect(order.userId).toBe('user1');
        });

        test('should add a sell order', () => {
            const order = algo.addSellOrder(100, 5, 'user2');
            expect(order.type).toBe('SELL');
            expect(order.price).toBe(100);
            expect(order.quantity).toBe(5);
            expect(order.userId).toBe('user2');
        });

        test('should add multiple buy orders', () => {
            algo.addBuyOrder(100, 10, 'user1');
            algo.addBuyOrder(105, 5, 'user2');
            algo.addBuyOrder(98, 15, 'user3');
            
            const orderBook = algo.getOrderBook();
            expect(orderBook.bids).toHaveLength(3);
        });

        test('should add multiple sell orders', () => {
            algo.addSellOrder(100, 10, 'user1');
            algo.addSellOrder(95, 5, 'user2');
            algo.addSellOrder(110, 15, 'user3');
            
            const orderBook = algo.getOrderBook();
            expect(orderBook.asks).toHaveLength(3);
        });
    });

    describe('Order Book Sorting', () => {
        test('should sort buy orders by price (highest first)', () => {
            algo.addBuyOrder(100, 10, 'user1');
            algo.addBuyOrder(105, 5, 'user2');
            algo.addBuyOrder(98, 15, 'user3');
            
            const orderBook = algo.getOrderBook();
            expect(orderBook.bids[0].price).toBe(105); // Highest price first
            expect(orderBook.bids[1].price).toBe(100);
            expect(orderBook.bids[2].price).toBe(98);
        });

        test('should sort sell orders by price (lowest first)', () => {
            algo.addSellOrder(100, 10, 'user1');
            algo.addSellOrder(95, 5, 'user2');
            algo.addSellOrder(110, 15, 'user3');
            
            const orderBook = algo.getOrderBook();
            expect(orderBook.asks[0].price).toBe(95); // Lowest price first
            expect(orderBook.asks[1].price).toBe(100);
            expect(orderBook.asks[2].price).toBe(110);
        });

        test('should sort orders by time when prices are equal', () => {
            algo.addBuyOrder(100, 10, 'user1');
            algo.addBuyOrder(100, 5, 'user2');
            algo.addBuyOrder(100, 15, 'user3');
            
            const orderBook = algo.getOrderBook();
            expect(orderBook.bids[0].userId).toBe('user1'); // First order placed
            expect(orderBook.bids[1].userId).toBe('user2');
            expect(orderBook.bids[2].userId).toBe('user3');
        });
    });

    describe('Order Matching - Basic Cases', () => {
        test('should match a simple buy and sell order', () => {
            algo.addBuyOrder(100, 10, 'buyer1');
            algo.addSellOrder(100, 10, 'seller1');
            
            const trades = algo.getTrades();
            expect(trades).toHaveLength(1);
            expect(trades[0].price).toBe(100);
            expect(trades[0].quantity).toBe(10);
            expect(trades[0].buyer).toBe('buyer1');
            expect(trades[0].seller).toBe('seller1');
            
            const orderBook = algo.getOrderBook();
            expect(orderBook.bids).toHaveLength(0);
            expect(orderBook.asks).toHaveLength(0);
        });

        test('should match when buy price is higher than sell price', () => {
            algo.addBuyOrder(105, 10, 'buyer1');
            algo.addSellOrder(100, 10, 'seller1');
            
            const trades = algo.getTrades();
            expect(trades).toHaveLength(1);
            expect(trades[0].quantity).toBe(10);
        });

        test('should not match when buy price is lower than sell price', () => {
            algo.addBuyOrder(95, 10, 'buyer1');
            algo.addSellOrder(100, 10, 'seller1');
            
            const trades = algo.getTrades();
            expect(trades).toHaveLength(0);
            
            const orderBook = algo.getOrderBook();
            expect(orderBook.bids).toHaveLength(1);
            expect(orderBook.asks).toHaveLength(1);
        });
    });

    describe('Order Matching - Partial Fills', () => {
        test('should partially fill a large buy order', () => {
            algo.addBuyOrder(100, 20, 'buyer1');
            algo.addSellOrder(100, 10, 'seller1');
            
            const trades = algo.getTrades();
            expect(trades).toHaveLength(1);
            expect(trades[0].quantity).toBe(10);
            
            const orderBook = algo.getOrderBook();
            expect(orderBook.bids).toHaveLength(1);
            expect(orderBook.bids[0].quantity).toBe(10); // Remaining quantity
            expect(orderBook.asks).toHaveLength(0);
        });

        test('should partially fill a large sell order', () => {
            algo.addBuyOrder(100, 5, 'buyer1');
            algo.addSellOrder(100, 15, 'seller1');
            
            const trades = algo.getTrades();
            expect(trades).toHaveLength(1);
            expect(trades[0].quantity).toBe(5);
            
            const orderBook = algo.getOrderBook();
            expect(orderBook.bids).toHaveLength(0);
            expect(orderBook.asks).toHaveLength(1);
            expect(orderBook.asks[0].quantity).toBe(10); // Remaining quantity
        });

        test('should match multiple sell orders against one buy order', () => {
            algo.addBuyOrder(100, 30, 'buyer1');
            algo.addSellOrder(100, 10, 'seller1');
            algo.addSellOrder(100, 15, 'seller2');
            
            const trades = algo.getTrades();
            expect(trades).toHaveLength(2);
            expect(trades[0].quantity).toBe(10);
            expect(trades[1].quantity).toBe(15);
            
            const orderBook = algo.getOrderBook();
            expect(orderBook.bids[0].quantity).toBe(5); // Remaining: 30 - 10 - 15
        });

        test('should match multiple buy orders against one sell order', () => {
            algo.addSellOrder(100, 30, 'seller1');
            algo.addBuyOrder(100, 10, 'buyer1');
            algo.addBuyOrder(100, 15, 'buyer2');
            
            const trades = algo.getTrades();
            expect(trades).toHaveLength(2);
            expect(trades[0].quantity).toBe(10);
            expect(trades[1].quantity).toBe(15);
            
            const orderBook = algo.getOrderBook();
            expect(orderBook.asks[0].quantity).toBe(5); // Remaining: 30 - 10 - 15
        });
    });

    describe('Order Matching - Price Priority', () => {
        test('should match best bid with best ask', () => {
            algo.addBuyOrder(100, 10, 'buyer1');
            algo.addBuyOrder(105, 5, 'buyer2'); // Best bid
            algo.addSellOrder(102, 5, 'seller1');
            
            const trades = algo.getTrades();
            expect(trades).toHaveLength(1);
            expect(trades[0].buyer).toBe('buyer2'); // Highest bid matches
            expect(trades[0].quantity).toBe(5);
        });

        test('should match lowest ask with highest bid', () => {
            algo.addSellOrder(105, 10, 'seller1');
            algo.addSellOrder(100, 5, 'seller2'); // Best ask
            algo.addBuyOrder(103, 5, 'buyer1');
            
            const trades = algo.getTrades();
            expect(trades).toHaveLength(1);
            expect(trades[0].seller).toBe('seller2'); // Lowest ask matches
            expect(trades[0].quantity).toBe(5);
        });

        test('should execute trade at maker price (order already on book)', () => {
            algo.addBuyOrder(105, 10, 'buyer1'); // Maker at 105
            algo.addSellOrder(100, 10, 'seller1'); // Taker crosses spread
            
            const trades = algo.getTrades();
            expect(trades[0].price).toBe(105); // Executes at maker's price (buy order)
            
            algo.reset();
            
            algo.addSellOrder(100, 10, 'seller1'); // Maker at 100
            algo.addBuyOrder(105, 10, 'buyer1'); // Taker crosses spread
            
            const trades2 = algo.getTrades();
            expect(trades2[0].price).toBe(100); // Executes at maker's price (sell order)
        });
    });

    describe('Order Book Queries', () => {
        test('should get best bid price', () => {
            algo.addBuyOrder(100, 10, 'buyer1');
            algo.addBuyOrder(105, 5, 'buyer2');
            algo.addBuyOrder(98, 15, 'buyer3');
            
            expect(algo.getBestBid()).toBe(105);
        });

        test('should get best ask price', () => {
            algo.addSellOrder(100, 10, 'seller1');
            algo.addSellOrder(95, 5, 'seller2');
            algo.addSellOrder(110, 15, 'seller3');
            
            expect(algo.getBestAsk()).toBe(95);
        });

        test('should return null for best bid when no orders', () => {
            expect(algo.getBestBid()).toBeNull();
        });

        test('should return null for best ask when no orders', () => {
            expect(algo.getBestAsk()).toBeNull();
        });

        test('should calculate spread correctly', () => {
            algo.addBuyOrder(98, 10, 'buyer1');
            algo.addSellOrder(102, 10, 'seller1');
            
            expect(algo.getSpread()).toBe(4); // 102 - 98
        });

        test('should return null spread when order book is incomplete', () => {
            algo.addBuyOrder(98, 10, 'buyer1');
            expect(algo.getSpread()).toBeNull();
        });
    });

    describe('Order Cancellation', () => {
        test('should cancel a buy order', () => {
            const order = algo.addBuyOrder(100, 10, 'buyer1');
            const cancelled = algo.cancelOrder(order.id);
            
            expect(cancelled).toBe(true);
            const orderBook = algo.getOrderBook();
            expect(orderBook.bids).toHaveLength(0);
        });

        test('should cancel a sell order', () => {
            const order = algo.addSellOrder(100, 10, 'seller1');
            const cancelled = algo.cancelOrder(order.id);
            
            expect(cancelled).toBe(true);
            const orderBook = algo.getOrderBook();
            expect(orderBook.asks).toHaveLength(0);
        });

        test('should return false when cancelling non-existent order', () => {
            const cancelled = algo.cancelOrder(999);
            expect(cancelled).toBe(false);
        });

        test('should not cancel already matched orders', () => {
            const buyOrder = algo.addBuyOrder(100, 10, 'buyer1');
            algo.addSellOrder(100, 10, 'seller1');
            
            const cancelled = algo.cancelOrder(buyOrder.id);
            expect(cancelled).toBe(false); // Order already matched and removed
        });
    });

    describe('Complex Scenarios', () => {
        test('should handle multiple matches in sequence', () => {
            algo.addBuyOrder(105, 10, 'buyer1');
            algo.addBuyOrder(103, 15, 'buyer2');
            algo.addBuyOrder(100, 20, 'buyer3');
            
            algo.addSellOrder(99, 30, 'seller1');
            
            const trades = algo.getTrades();
            expect(trades).toHaveLength(3);
            
            // All buy orders should match with the sell order
            expect(trades[0].buyer).toBe('buyer1');
            expect(trades[0].quantity).toBe(10);
            
            expect(trades[1].buyer).toBe('buyer2');
            expect(trades[1].quantity).toBe(15);
            
            expect(trades[2].buyer).toBe('buyer3');
            expect(trades[2].quantity).toBe(5); // Partial fill: 30 - 10 - 15 = 5
            
            const orderBook = algo.getOrderBook();
            expect(orderBook.bids[0].quantity).toBe(15); // buyer3 has 15 remaining
        });

        test('should handle market depth with multiple price levels', () => {
            // Create market depth
            algo.addBuyOrder(100, 10, 'buyer1');
            algo.addBuyOrder(99, 20, 'buyer2');
            algo.addBuyOrder(98, 30, 'buyer3');
            
            algo.addSellOrder(101, 10, 'seller1');
            algo.addSellOrder(102, 20, 'seller2');
            algo.addSellOrder(103, 30, 'seller3');
            
            // No matches should occur (spread exists)
            expect(algo.getTrades()).toHaveLength(0);
            expect(algo.getSpread()).toBe(1); // 101 - 100
            
            // Add aggressive sell order that crosses spread
            algo.addSellOrder(99, 25, 'seller4');
            
            const trades = algo.getTrades();
            expect(trades).toHaveLength(2);
            expect(trades[0].price).toBe(100);
            expect(trades[0].quantity).toBe(10);
            expect(trades[1].price).toBe(99);
            expect(trades[1].quantity).toBe(15); // Partial fill of 25
        });

        test('should maintain order book integrity after multiple operations', () => {
            // Add orders
            const order1 = algo.addBuyOrder(100, 10, 'buyer1');
            algo.addBuyOrder(99, 20, 'buyer2');
            const order3 = algo.addSellOrder(105, 15, 'seller1');
            
            // Cancel one order
            algo.cancelOrder(order1.id);
            
            // Add more orders
            algo.addSellOrder(98, 25, 'seller2');
            
            // Should match with buyer2
            const trades = algo.getTrades();
            expect(trades).toHaveLength(1);
            expect(trades[0].buyer).toBe('buyer2');
            expect(trades[0].quantity).toBe(20);
            
            const orderBook = algo.getOrderBook();
            expect(orderBook.bids).toHaveLength(0);
            expect(orderBook.asks).toHaveLength(2);
        });
    });

    describe('Reset Functionality', () => {
        test('should reset order book and trades', () => {
            algo.addBuyOrder(100, 10, 'buyer1');
            algo.addSellOrder(100, 10, 'seller1');
            
            algo.reset();
            
            expect(algo.getTrades()).toHaveLength(0);
            const orderBook = algo.getOrderBook();
            expect(orderBook.bids).toHaveLength(0);
            expect(orderBook.asks).toHaveLength(0);
        });
    });
});
