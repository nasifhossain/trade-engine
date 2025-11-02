const { randomUUID } = require('crypto');
const { DB } = require('../db/query');

/**
 * Trading Matching Engine
 * Implements price-time priority matching for limit and market orders
 */
class MatchingEngine {
    constructor(pool, redisService) {
        this.pool = pool;
        this.redisService = redisService;
        
        // Initialize DB with the pool
        DB.init(pool);
        
        // In-memory order book for fast matching
        this.orderBook = {
            bids: new Map(), // price -> [orders] (sorted by time)
            asks: new Map()  // price -> [orders] (sorted by time)
        };
        
        // Mutex for thread safety (simple flag-based implementation)
        this.isMatching = false;
    }

    /**
     * Initialize the matching engine by loading existing orders from DB
     */
    async initialize() {
        try {
            console.log('🔄 Initializing matching engine...');
            
            // Load open orders from database
            const openOrdersQuery = await DB.find('orders', { status: 'open' });
            const partialOrdersQuery = await DB.find('orders', { status: 'partially_filled' });
            
            const openOrders = [...openOrdersQuery, ...partialOrdersQuery];

            console.log(`📋 Loading ${openOrders.length} open orders into order book`);

            // Rebuild order book from existing orders
            let bidsLoaded = 0;
            let asksLoaded = 0;
            
            for (const order of openOrders) {
                this._addOrderToBook(order);
                if (order.side === 'buy') {
                    bidsLoaded++;
                } else {
                    asksLoaded++;
                }
            }

            console.log('✅ Matching engine initialized successfully');
            console.log(`📊 Order book: ${this.orderBook.bids.size} bid levels (${bidsLoaded} orders), ${this.orderBook.asks.size} ask levels (${asksLoaded} orders)`);
            
            // Log current best bid/ask for debugging
            const bestBid = this.orderBook.bids.size > 0 ? Math.max(...this.orderBook.bids.keys()) : null;
            const bestAsk = this.orderBook.asks.size > 0 ? Math.min(...this.orderBook.asks.keys()) : null;
            
            if (bestBid || bestAsk) {
                console.log(`💰 Best prices - Bid: ${bestBid || 'N/A'}, Ask: ${bestAsk || 'N/A'}`);
            }
            
        } catch (error) {
            console.error('❌ Error initializing matching engine:', error);
            throw error;
        }
    }

    /**
     * Process an incoming order and perform matching
     * @param {Object} order - The incoming order
     * @returns {Object} Match results with trades and updated order
     */
    async processOrder(order) {
        // Acquire mutex (simple implementation)
        while (this.isMatching) {
            await new Promise(resolve => setTimeout(resolve, 1));
        }
        this.isMatching = true;

        try {
            const matchResult = {
                trades: [],
                orderUpdates: [],
                bookUpdates: []
            };

            if (order.type === 'market') {
                await this._processMarketOrder(order, matchResult);
            } else if (order.type === 'limit') {
                await this._processLimitOrder(order, matchResult);
            }

            // Persist all changes to database
            await this._persistMatchResult(matchResult);
            
            // Log processing summary
            if (matchResult.trades.length > 0) {
                console.log(`💫 Order ${order.order_id} processing complete:`);
                console.log(`   → ${matchResult.trades.length} trades executed`);
                console.log(`   → ${matchResult.orderUpdates.length} orders updated`);
                console.log(`   → Order status: ${order.status} (${order.filled_quantity}/${order.quantity} filled)`);
            } else {
                console.log(`📋 Order ${order.order_id} added to book (no immediate matches)`);
            }

            return matchResult;

        } finally {
            this.isMatching = false;
        }
    }

    /**
     * Process a market order - match immediately at best available prices
     */
    async _processMarketOrder(order, matchResult) {
        const oppositeBook = order.side === 'buy' ? this.orderBook.asks : this.orderBook.bids;
        let remainingQuantity = order.quantity - order.filled_quantity;

        // Get sorted price levels (ascending for asks, descending for bids)
        const sortedPrices = Array.from(oppositeBook.keys()).sort((a, b) => 
            order.side === 'buy' ? a - b : b - a
        );

        for (const price of sortedPrices) {
            if (remainingQuantity <= 0) break;

            const ordersAtPrice = oppositeBook.get(price);
            if (!ordersAtPrice || ordersAtPrice.length === 0) continue;

            // Process orders at this price level (FIFO - first in, first out)
            for (let i = 0; i < ordersAtPrice.length; i++) {
                const makerOrder = ordersAtPrice[i];
                if (remainingQuantity <= 0) break;

                const matchQuantity = Math.min(
                    remainingQuantity, 
                    makerOrder.quantity - makerOrder.filled_quantity
                );

                if (matchQuantity > 0) {
                    // Create trade
                    const trade = this._createTrade(order, makerOrder, price, matchQuantity);
                    matchResult.trades.push(trade);
                    
                    console.log(`🔄 Market order match: ${matchQuantity} ${order.instrument} @ ${price} (${order.side} vs ${makerOrder.side})`);
                    console.log(`   → Taker: ${order.order_id} (${order.client_id})`);
                    console.log(`   → Maker: ${makerOrder.order_id} (${makerOrder.client_id})`);

                    // Update order quantities
                    order.filled_quantity += matchQuantity;
                    makerOrder.filled_quantity += matchQuantity;
                    remainingQuantity -= matchQuantity;

                    // Update order statuses
                    this._updateOrderStatus(order);
                    this._updateOrderStatus(makerOrder);

                    matchResult.orderUpdates.push({...order});
                    matchResult.orderUpdates.push({...makerOrder});

                    // If maker order is fully filled, remove from book
                    if (makerOrder.filled_quantity >= makerOrder.quantity) {
                        ordersAtPrice.splice(i, 1);
                        i--; // Adjust index after removal
                        console.log(`   → Maker order ${makerOrder.order_id} fully filled and removed from book`);
                    }
                }
            }

            // Clean up empty price levels
            if (ordersAtPrice.length === 0) {
                oppositeBook.delete(price);
                matchResult.bookUpdates.push({
                    action: 'remove_level',
                    side: order.side === 'buy' ? 'ask' : 'bid',
                    price: price
                });
            }
        }

        // Update market order status
        this._updateOrderStatus(order);
    }

    /**
     * Process a limit order - match what's possible, then add to book
     */
    async _processLimitOrder(order, matchResult) {
        const oppositeBook = order.side === 'buy' ? this.orderBook.asks : this.orderBook.bids;
        let remainingQuantity = order.quantity - order.filled_quantity;

        // For buy orders, match with asks at or below the limit price
        // For sell orders, match with bids at or above the limit price
        const sortedPrices = Array.from(oppositeBook.keys())
            .filter(price => order.side === 'buy' ? price <= order.price : price >= order.price)
            .sort((a, b) => order.side === 'buy' ? a - b : b - a);

        // Try to match with existing orders
        for (const price of sortedPrices) {
            if (remainingQuantity <= 0) break;

            const ordersAtPrice = oppositeBook.get(price);
            if (!ordersAtPrice || ordersAtPrice.length === 0) continue;

            for (let i = 0; i < ordersAtPrice.length; i++) {
                const makerOrder = ordersAtPrice[i];
                if (remainingQuantity <= 0) break;

                const matchQuantity = Math.min(
                    remainingQuantity,
                    makerOrder.quantity - makerOrder.filled_quantity
                );

                if (matchQuantity > 0) {
                    // Trade at maker's price (price improvement for taker)
                    const trade = this._createTrade(order, makerOrder, price, matchQuantity);
                    matchResult.trades.push(trade);
                    
                    console.log(`🔄 Limit order match: ${matchQuantity} ${order.instrument} @ ${price} (${order.side} vs ${makerOrder.side})`);
                    console.log(`   → Taker: ${order.order_id} (${order.client_id}) - limit ${order.price}`);
                    console.log(`   → Maker: ${makerOrder.order_id} (${makerOrder.client_id}) - got ${price}`);

                    // Update quantities
                    order.filled_quantity += matchQuantity;
                    makerOrder.filled_quantity += matchQuantity;
                    remainingQuantity -= matchQuantity;

                    // Update statuses
                    this._updateOrderStatus(order);
                    this._updateOrderStatus(makerOrder);

                    matchResult.orderUpdates.push({...order});
                    matchResult.orderUpdates.push({...makerOrder});

                    // Remove fully filled maker order
                    if (makerOrder.filled_quantity >= makerOrder.quantity) {
                        ordersAtPrice.splice(i, 1);
                        i--;
                        console.log(`   → Maker order ${makerOrder.order_id} fully filled and removed from book`);
                    }
                }
            }

            // Clean up empty price levels
            if (ordersAtPrice.length === 0) {
                oppositeBook.delete(price);
                matchResult.bookUpdates.push({
                    action: 'remove_level',
                    side: order.side === 'buy' ? 'ask' : 'bid',
                    price: price
                });
            }
        }

        // If there's remaining quantity, add to order book
        if (remainingQuantity > 0) {
            this._addOrderToBook(order);
            matchResult.bookUpdates.push({
                action: 'add_order',
                side: order.side,
                price: order.price,
                order: {...order}
            });
        }

        this._updateOrderStatus(order);
    }

    /**
     * Add an order to the in-memory order book
     */
    _addOrderToBook(order) {
        if (order.status === 'filled' || order.status === 'cancelled') {
            return; // Don't add completed orders
        }

        const book = order.side === 'buy' ? this.orderBook.bids : this.orderBook.asks;
        const price = order.price;

        if (!book.has(price)) {
            book.set(price, []);
        }

        // Insert in time order (FIFO)
        book.get(price).push(order);
    }

    /**
     * Create a trade record with all required fields for the trades table
     */
    _createTrade(takerOrder, makerOrder, price, quantity) {
        const buyOrder = takerOrder.side === 'buy' ? takerOrder : makerOrder;
        const sellOrder = takerOrder.side === 'sell' ? takerOrder : makerOrder;

        return {
            trade_id: randomUUID(),
            buy_order_id: buyOrder.order_id,
            sell_order_id: sellOrder.order_id,
            instrument: takerOrder.instrument,
            price: parseFloat(price),
            quantity: parseFloat(quantity),
            buy_client_id: buyOrder.client_id,
            sell_client_id: sellOrder.client_id,
            // Note: executed_at will be set by database default (CURRENT_TIMESTAMP)
            // But we can also set it explicitly if needed
            executed_at: new Date(),
            
            // Additional metadata for internal use (not stored in DB)
            taker_order_id: takerOrder.order_id,
            maker_order_id: makerOrder.order_id,
            taker_side: takerOrder.side
        };
    }

    /**
     * Update order status based on filled quantity
     */
    _updateOrderStatus(order) {
        if (order.filled_quantity >= order.quantity) {
            order.status = 'filled';
        } else if (order.filled_quantity > 0) {
            order.status = 'partially_filled';
        }
        order.updated_at = new Date();
    }

    /**
     * Persist all match results to database
     */
    async _persistMatchResult(matchResult) {
        try {
            // Start transaction - we'll use the DB class which should handle transactions
            // For now, we'll do individual operations and add transaction support later
            
            // Insert trades into trades table
            for (const trade of matchResult.trades) {
                // Prepare trade data for database (exclude metadata fields)
                // Ensure all numeric values are properly formatted
                const tradeData = {
                    trade_id: trade.trade_id,
                    buy_order_id: trade.buy_order_id,
                    sell_order_id: trade.sell_order_id,
                    instrument: trade.instrument,
                    price: parseFloat(trade.price).toFixed(8), // Ensure decimal precision
                    quantity: parseFloat(trade.quantity).toFixed(8), // Ensure decimal precision
                    buy_client_id: trade.buy_client_id,
                    sell_client_id: trade.sell_client_id,
                    executed_at: trade.executed_at
                };

                console.log(`Inserting trade: ${trade.trade_id} - ${trade.quantity} ${trade.instrument} @ ${trade.price}`);
                
                const insertResult = await DB.insert('trades', tradeData);
                
                if (!insertResult.success) {
                    throw new Error(`Failed to insert trade ${trade.trade_id}`);
                }

                console.log(`✓ Trade ${trade.trade_id} inserted successfully`);
            }

            // Update orders in orders table
            for (const order of matchResult.orderUpdates) {
                console.log(`Updating order: ${order.order_id} - filled: ${order.filled_quantity}/${order.quantity}, status: ${order.status}`);
                
                const updateResult = await DB.update('orders', 
                    {
                        filled_quantity: parseFloat(order.filled_quantity).toFixed(8),
                        status: order.status,
                        updated_at: order.updated_at
                    },
                    { order_id: order.order_id }
                );

                if (!updateResult.success) {
                    throw new Error(`Failed to update order ${order.order_id}`);
                }

                console.log(`✓ Order ${order.order_id} updated successfully`);
            }

            console.log(`✓ Match result persisted: ${matchResult.trades.length} trades, ${matchResult.orderUpdates.length} order updates`);

        } catch (error) {
            console.error('❌ Error persisting match result:', error);
            throw error;
        }
    }

    /**
     * Cancel an order and remove it from the order book
     */
    async cancelOrder(orderId) {
        try {
            // Find the order in database first
            const order = await DB.find_one('orders', { order_id: orderId });
            if (!order) {
                throw new Error('Order not found');
            }

            if (order.status === 'filled' || order.status === 'cancelled') {
                throw new Error('Cannot cancel order that is already filled or cancelled');
            }

            // Remove from order book
            const book = order.side === 'buy' ? this.orderBook.bids : this.orderBook.asks;
            const ordersAtPrice = book.get(order.price);
            
            if (ordersAtPrice) {
                const index = ordersAtPrice.findIndex(o => o.order_id === orderId);
                if (index !== -1) {
                    ordersAtPrice.splice(index, 1);
                }

                // Clean up empty price level
                if (ordersAtPrice.length === 0) {
                    book.delete(order.price);
                }
            }

            // Update status in database
            await DB.update('orders', { order_id: orderId }, {
                status: 'cancelled',
                updated_at: new Date()
            });

            return {
                success: true,
                message: 'Order cancelled successfully',
                order_id: orderId
            };

        } catch (error) {
            console.error('Error cancelling order:', error);
            throw error;
        }
    }

    /**
     * Get current order book state
     */
    getOrderBook(instrument, levels = 20) {
        const bids = [];
        const asks = [];

        // Process bids (highest price first)
        const sortedBidPrices = Array.from(this.orderBook.bids.keys()).sort((a, b) => b - a);
        for (const price of sortedBidPrices.slice(0, levels)) {
            const orders = this.orderBook.bids.get(price) || [];
            const totalQuantity = orders.reduce((sum, order) => 
                sum + (order.quantity - order.filled_quantity), 0);
            
            if (totalQuantity > 0) {
                bids.push({
                    price: parseFloat(price),
                    quantity: parseFloat(totalQuantity.toFixed(8)),
                    orders: orders.length
                });
            }
        }

        // Process asks (lowest price first)
        const sortedAskPrices = Array.from(this.orderBook.asks.keys()).sort((a, b) => a - b);
        for (const price of sortedAskPrices.slice(0, levels)) {
            const orders = this.orderBook.asks.get(price) || [];
            const totalQuantity = orders.reduce((sum, order) => 
                sum + (order.quantity - order.filled_quantity), 0);
            
            if (totalQuantity > 0) {
                asks.push({
                    price: parseFloat(price),
                    quantity: parseFloat(totalQuantity.toFixed(8)),
                    orders: orders.length
                });
            }
        }

        return {
            instrument,
            bids,
            asks,
            spread: asks.length > 0 && bids.length > 0 ? 
                parseFloat((asks[0].price - bids[0].price).toFixed(8)) : null,
            timestamp: new Date()
        };
    }

    /**
     * Get order book depth with cumulative quantities
     */
    getOrderBookDepth(instrument, levels = 20) {
        const orderBook = this.getOrderBook(instrument, levels);
        
        // Add cumulative quantities
        let bidCumulative = 0;
        orderBook.bids = orderBook.bids.map(level => {
            bidCumulative += level.quantity;
            return {
                ...level,
                cumulative: parseFloat(bidCumulative.toFixed(8))
            };
        });

        let askCumulative = 0;
        orderBook.asks = orderBook.asks.map(level => {
            askCumulative += level.quantity;
            return {
                ...level,
                cumulative: parseFloat(askCumulative.toFixed(8))
            };
        });

        return orderBook;
    }
}

module.exports = MatchingEngine;
