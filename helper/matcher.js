const { randomUUID } = require('crypto');
const { DB } = require('../db/query');

/**
 * Trading Matching Engine - Redis Optimized
 * Implements price-time priority matching for limit and market orders
 * Uses Redis for scalable order book management and caching
 */
class MatchingEngine {
    constructor(pool, redisService) {
        this.pool = pool;
        this.redisService = redisService;
        
        // Initialize DB with the pool
        DB.init(pool);
        
        // Distributed lock for thread safety (using Redis)
        this.lockKey = 'matching:lock';
        this.lockTimeout = 5000; // 5 seconds
        this.maxRetries = 10;
        this.retryDelay = 10; // milliseconds
    }

    /**
     * Initialize the matching engine by loading existing orders from DB to Redis
     * Supports snapshot-based recovery for faster startup
     * @param {Object} snapshotService - Optional snapshot service for fast recovery
     */
    async initialize(snapshotService = null) {
        try {
            console.log('🔄 Initializing matching engine with Redis...');
            
            // Try snapshot-based recovery if available
            if (snapshotService && snapshotService.config.enabled) {
                console.log('📸 Using snapshot-based recovery...');
                const recoveryStats = await snapshotService.recoverAll();
                
                console.log('✅ Matching engine initialized successfully via snapshots');
                
                // Get book statistics from Redis
                const stats = await this._getOrderBookStats();
                console.log(`📊 Order book: ${stats.bidLevels} bid levels, ${stats.askLevels} ask levels`);
                
                if (stats.bestBid || stats.bestAsk) {
                    console.log(`💰 Best prices - Bid: ${stats.bestBid || 'N/A'}, Ask: ${stats.bestAsk || 'N/A'}`);
                }
                
                return recoveryStats;
            }
            
            // Fallback: Full replay from MySQL
            console.log('📋 Using full replay recovery (no snapshots)...');
            
            // Load open orders from database
            const openOrdersQuery = await DB.find('orders', { status: 'open' });
            const partialOrdersQuery = await DB.find('orders', { status: 'partially_filled' });
            
            const openOrders = [...openOrdersQuery, ...partialOrdersQuery];

            console.log(`📋 Loading ${openOrders.length} open orders into Redis order book`);

            // Batch load orders into Redis
            let bidsLoaded = 0;
            let asksLoaded = 0;
            
            for (const order of openOrders) {
                await this._addOrderToRedis(order);
                if (order.side === 'buy') {
                    bidsLoaded++;
                } else {
                    asksLoaded++;
                }
            }

            console.log('✅ Matching engine initialized successfully via full replay');
            
            // Get book statistics from Redis for default instrument
            const stats = await this._getOrderBookStats('BTC-USD');
            console.log(`📊 Order book (BTC-USD): ${stats.bidLevels} bid levels (${bidsLoaded} orders), ${stats.askLevels} ask levels (${asksLoaded} orders)`);
            
            if (stats.bestBid || stats.bestAsk) {
                console.log(`💰 Best prices - Bid: ${stats.bestBid || 'N/A'}, Ask: ${stats.bestAsk || 'N/A'}`);
            }
            
            return { method: 'full_replay', totalOrders: openOrders.length };
            
        } catch (error) {
            console.error('❌ Error initializing matching engine:', error);
            throw error;
        }
    }

    /**
     * Acquire distributed lock for matching operations
     */
    async _acquireLock() {
        let retries = 0;
        while (retries < this.maxRetries) {
            const locked = await this.redisService.redis.set(
                this.lockKey,
                Date.now().toString(),
                { EX: 5, NX: true }
            );
            
            if (locked) {
                return true;
            }
            
            await new Promise(resolve => setTimeout(resolve, this.retryDelay));
            retries++;
        }
        throw new Error('Failed to acquire matching lock - engine busy');
    }

    /**
     * Release distributed lock
     */
    async _releaseLock() {
        await this.redisService.redis.del(this.lockKey);
    }

    /**
     * Process an incoming order and perform matching
     * Acquires lock, matches, updates Redis, then persists to DB
     * @param {Object} order - The incoming order
     * @returns {Object} Match results with trades and updated order
     */
    async processOrder(order) {
        await this._acquireLock();

        try {
            const matchResult = {
                trades: [],
                orderUpdates: [],
                bookUpdates: []
            };

            // Cache order in Redis for fast lookups
            await this.redisService.storeOrderDetails(order.order_id, order);

            if (order.type === 'market') {
                await this._processMarketOrder(order, matchResult);
            } else if (order.type === 'limit') {
                await this._processLimitOrder(order, matchResult);
            }

            // Persist all changes to database and update Redis
            await this._persistMatchResult(matchResult, order);
            
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
            await this._releaseLock();
        }
    }

    /**
     * Process a market order - match immediately at best available prices
     * Uses Redis to fetch orders efficiently
     */
    async _processMarketOrder(order, matchResult) {
        const oppositeBooks = order.side === 'buy' 
            ? { key: `orderbook:${order.instrument}:sell`, side: 'sell' }
            : { key: `orderbook:${order.instrument}:buy`, side: 'buy' };

        let remainingQuantity = order.quantity - order.filled_quantity;

        // Get all orders from opposite side (Redis ZSET)
        const oppositeOrders = order.side === 'buy'
            ? await this.redisService.getTopOrders(order.instrument, 'sell', 1000)
            : await this.redisService.getTopOrders(order.instrument, 'buy', 1000);

        // Process orders at best prices first
        for (const oppositeOrderRef of oppositeOrders) {
            if (remainingQuantity <= 0) break;

            // Fetch full order details from Redis (cached)
            const makerOrder = await this.redisService.getOrderDetails(oppositeOrderRef.orderId);
            if (!makerOrder || makerOrder.status === 'filled') continue;

            const matchQuantity = Math.min(
                remainingQuantity,
                parseFloat(makerOrder.quantity) - parseFloat(makerOrder.filled_quantity)
            );

            if (matchQuantity > 0) {
                // Create and track trade
                const trade = this._createTrade(order, makerOrder, oppositeOrderRef.price, matchQuantity);
                matchResult.trades.push(trade);
                
                console.log(`🔄 Market order match: ${matchQuantity} ${order.instrument} @ ${oppositeOrderRef.price} (${order.side} vs ${makerOrder.side})`);
                console.log(`   → Taker: ${order.order_id} (${order.client_id})`);
                console.log(`   → Maker: ${makerOrder.order_id} (${makerOrder.client_id})`);

                // Update quantities
                order.filled_quantity += matchQuantity;
                makerOrder.filled_quantity = (parseFloat(makerOrder.filled_quantity) + matchQuantity).toString();
                remainingQuantity -= matchQuantity;

                // Update statuses
                this._updateOrderStatus(order);
                this._updateOrderStatus(makerOrder);

                matchResult.orderUpdates.push({...order});
                matchResult.orderUpdates.push({...makerOrder});

                // Update Redis if maker is fully filled
                if (parseFloat(makerOrder.filled_quantity) >= parseFloat(makerOrder.quantity)) {
                    await this.redisService.removeOrderFromBook(
                        order.instrument,
                        makerOrder.side,
                        makerOrder.order_id,
                        parseInt(makerOrder.created_at)
                    );
                    console.log(`   → Maker order ${makerOrder.order_id} fully filled and removed from book`);
                }
            }
        }

        // Update market order status
        this._updateOrderStatus(order);
    }

    /**
     * Process a limit order - match what's possible, then add to book
     * Efficiently uses Redis for order book management
     */
    async _processLimitOrder(order, matchResult) {
        let remainingQuantity = order.quantity - order.filled_quantity;

        // Get orders from opposite side
        const oppositeOrders = order.side === 'buy'
            ? await this.redisService.getTopOrders(order.instrument, 'sell', 1000)
            : await this.redisService.getTopOrders(order.instrument, 'buy', 1000);

        // Filter orders that match our limit price
        const matchableOrders = oppositeOrders.filter(o => 
            order.side === 'buy' ? o.price <= order.price : o.price >= order.price
        );

        // Try to match with existing orders
        for (const oppositeOrderRef of matchableOrders) {
            if (remainingQuantity <= 0) break;

            // Fetch full order details from Redis
            const makerOrder = await this.redisService.getOrderDetails(oppositeOrderRef.orderId);
            if (!makerOrder || makerOrder.status === 'filled') continue;

            const matchQuantity = Math.min(
                remainingQuantity,
                parseFloat(makerOrder.quantity) - parseFloat(makerOrder.filled_quantity)
            );

            if (matchQuantity > 0) {
                // Trade at maker's price (price improvement for taker)
                const trade = this._createTrade(order, makerOrder, oppositeOrderRef.price, matchQuantity);
                matchResult.trades.push(trade);
                
                console.log(`🔄 Limit order match: ${matchQuantity} ${order.instrument} @ ${oppositeOrderRef.price} (${order.side} vs ${makerOrder.side})`);
                console.log(`   → Taker: ${order.order_id} (${order.client_id}) - limit ${order.price}`);
                console.log(`   → Maker: ${makerOrder.order_id} (${makerOrder.client_id}) - got ${oppositeOrderRef.price}`);

                // Update quantities
                order.filled_quantity += matchQuantity;
                makerOrder.filled_quantity = (parseFloat(makerOrder.filled_quantity) + matchQuantity).toString();
                remainingQuantity -= matchQuantity;

                // Update statuses
                this._updateOrderStatus(order);
                this._updateOrderStatus(makerOrder);

                matchResult.orderUpdates.push({...order});
                matchResult.orderUpdates.push({...makerOrder});

                // Remove fully filled maker order from Redis
                if (parseFloat(makerOrder.filled_quantity) >= parseFloat(makerOrder.quantity)) {
                    await this.redisService.removeOrderFromBook(
                        order.instrument,
                        makerOrder.side,
                        makerOrder.order_id,
                        parseInt(makerOrder.created_at)
                    );
                    console.log(`   → Maker order ${makerOrder.order_id} fully filled and removed from book`);
                }
            }
        }

        // If there's remaining quantity, add to order book in Redis
        if (remainingQuantity > 0) {
            await this._addOrderToRedis(order);
            matchResult.bookUpdates.push({
                action: 'add_order',
                side: order.side,
                price: order.price,
                order_id: order.order_id
            });
        }

        this._updateOrderStatus(order);
    }

    /**
     * Add an order to Redis order book (ZSET for price-time priority)
     */
    async _addOrderToRedis(order) {
        if (order.status === 'filled' || order.status === 'cancelled') {
            return; // Don't add completed orders
        }

        const timestamp = order.created_at instanceof Date 
            ? order.created_at.getTime() 
            : new Date(order.created_at).getTime();

        await this.redisService.addOrderToBook(
            order.instrument,
            order.side,
            order.price,
            order.order_id,
            timestamp
        );
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
     * Persist all match results to database and update Redis
     * Batches operations for efficiency
     */
    async _persistMatchResult(matchResult, order) {
        try {
            // Insert trades into trades table
            for (const trade of matchResult.trades) {
                const tradeData = {
                    trade_id: trade.trade_id,
                    buy_order_id: trade.buy_order_id,
                    sell_order_id: trade.sell_order_id,
                    instrument: trade.instrument,
                    price: parseFloat(trade.price).toFixed(8),
                    quantity: parseFloat(trade.quantity).toFixed(8),
                    buy_client_id: trade.buy_client_id,
                    sell_client_id: trade.sell_client_id,
                    executed_at: trade.executed_at
                };

                console.log(`Inserting trade: ${trade.trade_id} - ${trade.quantity} ${trade.instrument} @ ${trade.price}`);
                
                const insertResult = await DB.insert('trades', tradeData);
                
                if (!insertResult.success) {
                    throw new Error(`Failed to insert trade ${trade.trade_id}`);
                }

                // Add to recent trades in Redis for fast access
                await this.redisService.addRecentTrade(trade.instrument, trade);
                
                console.log(`✓ Trade ${trade.trade_id} persisted`);
            }

            // Update orders in database and Redis cache
            for (const updatedOrder of matchResult.orderUpdates) {
                console.log(`Updating order: ${updatedOrder.order_id} - filled: ${updatedOrder.filled_quantity}/${updatedOrder.quantity}, status: ${updatedOrder.status}`);
                
                const updateResult = await DB.update('orders', 
                    {
                        filled_quantity: parseFloat(updatedOrder.filled_quantity).toFixed(8),
                        status: updatedOrder.status,
                        updated_at: updatedOrder.updated_at
                    },
                    { order_id: updatedOrder.order_id }
                );

                if (!updateResult.success) {
                    throw new Error(`Failed to update order ${updatedOrder.order_id}`);
                }

                // Update Redis cache
                await this.redisService.updateOrderStatus(
                    updatedOrder.order_id,
                    updatedOrder.status,
                    updatedOrder.filled_quantity
                );

                console.log(`✓ Order ${updatedOrder.order_id} persisted`);
            }

            // Update metrics in Redis
            if (matchResult.trades.length > 0) {
                await this.redisService.incrementMetric(`trades:${order.instrument}`, matchResult.trades.length);
                await this.redisService.incrementMetric('trades:total', matchResult.trades.length);
            }

            console.log(`✓ Match result persisted: ${matchResult.trades.length} trades, ${matchResult.orderUpdates.length} order updates`);

        } catch (error) {
            console.error('❌ Error persisting match result:', error);
            throw error;
        }
    }

    /**
     * Cancel an order and remove it from Redis order book
     */
    async cancelOrder(orderId) {
        try {
            // Try Redis cache first for faster lookup
            let order = await this.redisService.getOrderDetails(orderId);
            
            // If not in Redis, fetch from database
            if (!order) {
                const dbResult = await DB.find_one('orders', { order_id: orderId });
                order = dbResult;
                if (!order) {
                    throw new Error('Order not found');
                }
            }

            if (order.status === 'filled' || order.status === 'cancelled') {
                throw new Error('Cannot cancel order that is already filled or cancelled');
            }

            // Remove from Redis order book
            const timestamp = order.created_at instanceof Date 
                ? order.created_at.getTime() 
                : new Date(order.created_at).getTime();

            await this.redisService.removeOrderFromBook(
                order.instrument,
                order.side,
                orderId,
                timestamp
            );

            // Update status in database
            await DB.update('orders', 
                {
                    status: 'cancelled',
                    updated_at: new Date()
                },
                { order_id: orderId }
            );

            // Update Redis cache
            await this.redisService.updateOrderStatus(orderId, 'cancelled', order.filled_quantity);

            // Increment metrics
            await this.redisService.incrementMetric('orders:cancelled');

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
     * Get current order book state from Redis
     * Much faster than in-memory map due to ZSET sorting
     */
    async getOrderBook(instrument, levels = 20) {
        try {
            const orderBook = await this.redisService.getOrderBook(instrument, levels);
            
            return {
                instrument,
                bids: orderBook.bids.map(bid => ({
                    price: parseFloat(bid.price),
                    quantity: this._calculateLevelQuantity(bid),
                    orders: 1
                })),
                asks: orderBook.asks.map(ask => ({
                    price: parseFloat(ask.price),
                    quantity: this._calculateLevelQuantity(ask),
                    orders: 1
                })),
                spread: orderBook.asks.length > 0 && orderBook.bids.length > 0 
                    ? parseFloat((orderBook.asks[0].price - orderBook.bids[0].price).toFixed(8)) 
                    : null,
                timestamp: new Date()
            };
        } catch (error) {
            console.error('Error getting order book:', error);
            throw error;
        }
    }

    /**
     * Get order book depth with cumulative quantities from Redis
     */
    async getOrderBookDepth(instrument, levels = 20) {
        try {
            const orderBook = await this.getOrderBook(instrument, levels);
            
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
        } catch (error) {
            console.error('Error getting order book depth:', error);
            throw error;
        }
    }

    /**
     * Helper method to calculate level quantity (placeholder)
     */
    _calculateLevelQuantity(level) {
        return parseFloat(level.quantity || '0');
    }

    /**
     * Get order book statistics from Redis
     * @param {string} instrument - Trading instrument (e.g., 'BTC-USD')
     */
    async _getOrderBookStats(instrument = 'BTC-USD') {
        try {
            // Get top bids and asks for the specific instrument
            const bids = await this.redisService.getTopOrders(instrument, 'buy', 1000);
            const asks = await this.redisService.getTopOrders(instrument, 'sell', 1000);

            const bestBid = bids.length > 0 ? bids[0].price : null;
            const bestAsk = asks.length > 0 ? asks[0].price : null;

            return {
                bidLevels: bids.length,
                askLevels: asks.length,
                bestBid,
                bestAsk
            };
        } catch (error) {
            console.warn('Could not get order book stats:', error.message);
            return {
                bidLevels: 0,
                askLevels: 0,
                bestBid: null,
                bestAsk: null
            };
        }
    }
}

module.exports = MatchingEngine;
