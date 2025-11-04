const { randomUUID } = require('crypto');
const { DB, QueryBuilder } = require('../db/query');
const MatchingEngine = require('../helper/matcher');

/**
 * Order Services
 * Handles order creation and management for trading system
 */

class OrderServices {
    constructor(pool, redisService, snapshotService = null) {
        this.pool = pool;
        this.redisService = redisService;
        this.snapshotService = snapshotService;
        
        // Initialize DB with the pool
        DB.init(pool);
        
        // Initialize matching engine
        this.matchingEngine = new MatchingEngine(pool, redisService);
    }

    /**
     * Initialize the order services and matching engine
     * Uses snapshot-based recovery if snapshot service is available
     */
    async initialize() {
        try {
            await this.matchingEngine.initialize(this.snapshotService);
            console.log('Order services initialized successfully');
        } catch (error) {
            console.error('Error initializing order services:', error);
            throw error;
        }
    }

    /**
     * Create a new order (unified method for both buy and sell orders)
     * This is where the matching algorithm runs!
     * @param {Object} orderData - Order data from request body
     * @param {string} idempotencyKey - Idempotency key for duplicate prevention
     * @returns {Object} Created order with match results
     */
    async createOrder(orderData, idempotencyKey = null) {
        try {
            const { side } = orderData;

            // ========== HYBRID IDEMPOTENCY CHECK ==========
            // Check both Redis (fast) and SQL (durable) for idempotency
            if (idempotencyKey) {
                // 1. Check Redis cache first (fastest path)
                const redisCacheKey = `idempotency:${idempotencyKey}`;
                const redisCached = await this.redisService.redis.get(redisCacheKey);
                if (redisCached) {
                    console.log(`✅ Idempotency hit (Redis): ${idempotencyKey}`);
                    return JSON.parse(redisCached);
                }

                // 2. Check SQL database (durable, survives Redis restart)
                const sqlCached = await DB.find_one('idempotency_keys', { 
                    idempotency_key: idempotencyKey 
                });
                
                if (sqlCached) {
                    console.log(`✅ Idempotency hit (SQL): ${idempotencyKey}`);
                    
                    // Parse stored response
                    const cachedResponse = typeof sqlCached.response_data === 'string' 
                        ? JSON.parse(sqlCached.response_data)
                        : sqlCached.response_data;
                    
                    // Re-cache in Redis for future fast lookups
                    await this.redisService.redis.setEx(
                        redisCacheKey,
                        3600,
                        JSON.stringify(cachedResponse)
                    );
                    
                    return cachedResponse;
                }
            }

            // Validate required fields (basic validation)
            if (!orderData.client_id || !orderData.instrument || !side || !orderData.type || !orderData.quantity) {
                throw new Error('Missing required fields: client_id, instrument, side, type, quantity');
            }

            // Validate side
            if (!['buy', 'sell'].includes(side)) {
                throw new Error('Side must be either "buy" or "sell"');
            }

            let result;

            // Route to appropriate method based on side - these have full matching engine integration!
            if (side === 'sell') {
                console.log('🔄 Routing to createSellOrder with matching engine...');
                result = await this.createSellOrder(orderData);
            } else if (side === 'buy') {
                console.log('🔄 Routing to createBuyOrder with matching engine...');
                result = await this.createBuyOrder(orderData);
            }

            // ========== STORE IDEMPOTENCY IN BOTH REDIS AND SQL ==========
            if (idempotencyKey && result) {
                const order_id = result.order?.order_id;
                
                if (order_id) {
                    // 1. Store in SQL (durable, permanent record)
                    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
                    
                    try {
                        await DB.insert('idempotency_keys', {
                            idempotency_key: idempotencyKey,
                            order_id: order_id,
                            response_data: JSON.stringify(result),
                            http_status: 201,
                            expires_at: expiresAt
                        });
                        console.log(`✅ Idempotency stored in SQL: ${idempotencyKey} -> ${order_id}`);
                    } catch (sqlError) {
                        // If duplicate key error (race condition), it's okay - another request already stored it
                        if (!sqlError.message.includes('Duplicate entry')) {
                            console.error('Error storing idempotency in SQL:', sqlError);
                        }
                    }
                    
                    // 2. Store in Redis (fast lookups)
                    const idempotencyCacheKey = `idempotency:${idempotencyKey}`;
                    await this.redisService.redis.setEx(
                        idempotencyCacheKey,
                        3600, // 1 hour TTL
                        JSON.stringify(result)
                    );
                    console.log(`✅ Idempotency cached in Redis: ${idempotencyKey}`);
                }
            }

            return result;

        } catch (error) {
            console.error('Error creating order:', error);
            throw new Error(`Failed to create order: ${error.message}`);
        }
    }

    /**
     * Cancel an existing order
     * @param {string} orderId - Order ID to cancel
     * @returns {Object} Cancellation result
     */
    async cancelOrder(orderId) {
        try {
            if (!orderId) {
                throw new Error('Order ID is required');
            }

            // Use matching engine to cancel (it handles order book removal)
            const result = await this.matchingEngine.cancelOrder(orderId);

            // Clear cache
            const cacheKey = `order:${orderId}`;
            await this.redisService.redis.del(cacheKey);

            return result;

        } catch (error) {
            console.error('Error cancelling order:', error);
            throw new Error(`Failed to cancel order: ${error.message}`);
        }
    }

    /**
     * Get order by ID
     * @param {string} orderId - Order ID
     * @returns {Object} Order details
     */
    async getOrderById(orderId) {
        try {
            const cacheKey = `order:${orderId}`;
            
            // Try to get from Redis HASH first (where it's stored)
            try {
                const cachedHash = await this.redisService.redis.hGetAll(cacheKey);
                if (cachedHash && Object.keys(cachedHash).length > 0) {
                    return {
                        success: true,
                        source: 'cache',
                        order: cachedHash
                    };
                }
            } catch (cacheError) {
                console.warn(`Redis HASH retrieval error for ${cacheKey}:`, cacheError.message);
            }

            // Get from database
            const order = await DB.find_one('orders', { order_id: orderId });
            if (!order) {
                throw new Error('Order not found');
            }

            // Cache it as a HASH (matching how matcher stores it)
            try {
                await this.redisService.redis.hSet(cacheKey, order);
                await this.redisService.redis.expire(cacheKey, 300); // 5 minute TTL
            } catch (cacheError) {
                console.warn(`Failed to cache order in Redis:`, cacheError.message);
                // Continue anyway, order is available from DB
            }

            return {
                success: true,
                source: 'database',
                order
            };

        } catch (error) {
            console.error('Error getting order:', error);
            throw new Error(`Failed to get order: ${error.message}`);
        }
    }

    /**
     * Get current order book
     * @param {string} instrument - Trading instrument
     * @param {number} levels - Number of price levels to return
     * @returns {Object} Order book data
     */
    async getOrderBook(instrument = 'BTC-USD', levels = 20) {
        try {
            const orderBook = await this.matchingEngine.getOrderBookDepth(instrument, levels);
            return {
                success: true,
                ...orderBook
            };
        } catch (error) {
            console.error('Error getting order book:', error);
            throw new Error(`Failed to get order book: ${error.message}`);
        }
    }

    /**
     * Get recent trades
     * @param {Object} filters - Filter options
     * @returns {Object} Recent trades
     */
    async getTrades(filters = {}) {
        try {
            const {
                instrument,
                limit = 50,
                offset = 0
            } = filters;

            // Build cache key
            const cacheKey = `trades:${JSON.stringify(filters)}`;
            
            // Try cache first
            try {
                const cached = await this.redisService.redis.get(cacheKey);
                if (cached) {
                    return {
                        success: true,
                        source: 'cache',
                        ...JSON.parse(cached)
                    };
                }
            } catch (cacheError) {
                console.warn('Redis cache error:', cacheError);
            }

            // Build query
            let query = new QueryBuilder(this.pool).table('trades').select('*');

            if (instrument) {
                query = query.where('instrument', instrument);
            }

            query = query.order_by('executed_at', 'DESC').limit(limit, offset);

            const trades = await query.get();

            // Get total count
            let countQuery = new QueryBuilder(this.pool).table('trades').select('COUNT(*) as total');
            if (instrument) {
                countQuery = countQuery.where('instrument', instrument);
            }

            const countResult = await countQuery.get();
            const total = countResult[0]?.total || 0;

            const result = {
                trades,
                pagination: {
                    total,
                    limit,
                    offset,
                    hasMore: (offset + limit) < total
                }
            };

            // Cache result
            await this.redisService.redis.setEx(cacheKey, 30, JSON.stringify(result));

            return {
                success: true,
                source: 'database',
                ...result
            };

        } catch (error) {
            console.error('Error getting trades:', error);
            throw new Error(`Failed to get trades: ${error.message}`);
        }
    }

    /**
     * Create a sell order
     * @param {Object} orderData - Order data from request body
     * @returns {Object} Created order with generated UUID
     */
    async createSellOrder(orderData) {
        try {
            const {
                client_id,
                instrument,
                type,
                price,
                quantity,
                filled_quantity = 0,
                status = 'open'
            } = orderData;

            // Generate server-side UUID for order_id
            const order_id = randomUUID();
            
            // Validate required fields
            if (!client_id || !instrument || !type || !quantity) {
                throw new Error('Missing required fields: client_id, instrument, type, quantity');
            }

            // Validate order type
            if (!['limit', 'market'].includes(type)) {
                throw new Error('Order type must be either "limit" or "market"');
            }

            // Validate price for limit orders
            if (type === 'limit' && (!price || price <= 0)) {
                throw new Error('Price is required and must be greater than 0 for limit orders');
            }

            // Validate quantity
            if (quantity <= 0) {
                throw new Error('Quantity must be greater than 0');
            }

            // Validate status
            const validStatuses = ['open', 'partially_filled', 'filled', 'cancelled', 'rejected'];
            if (!validStatuses.includes(status)) {
                throw new Error(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
            }

            // Set side as sell (as per requirement)
            const side = 'sell';

            // Prepare order data for insertion
            const orderToInsert = {
                order_id,
                client_id,
                instrument,
                side,
                type,
                price: type === 'limit' ? price : null, // Price is null for market orders
                quantity,
                filled_quantity,
                status
            };

            // Insert order into database using query builder
            const insertResult = await DB.insert('orders', orderToInsert);

            if (!insertResult.success) {
                throw new Error('Failed to insert order into database');
            }

            // Construct the created order response (no extra DB fetch for performance)
            // Timestamps will be within milliseconds of actual DB values
            const now = new Date();
            const createdOrder = {
                ...orderToInsert,
                created_at: now,
                updated_at: now
            };

            // Cache the order in Redis using the dedicated method
            await this.redisService.storeOrderDetails(order_id, createdOrder);

            // Add order to the orderbook (only for limit orders that are open/partially_filled)
            if (type === 'limit' && ['open', 'partially_filled'].includes(status)) {
                await this.redisService.addOrderToBook(
                    instrument,
                    side,
                    parseFloat(price),
                    order_id,
                    now.getTime() // Timestamp in milliseconds
                );
            }

            // *** RUN MATCHING ENGINE FOR SELL ORDERS! ***
            const matchResult = await this.matchingEngine.processOrder(createdOrder);

            // createdOrder is now updated by matching engine (passed by reference)
            // Update Redis with final order state
            await this.redisService.storeOrderDetails(order_id, createdOrder);

            // Add recent trades to Redis for fast access
            for (const trade of matchResult.trades) {
                await this.redisService.addRecentTrade(instrument, trade);
            }

            // Remove filled orders from Redis order book
            for (const update of matchResult.orderUpdates) {
                if (update.status === 'filled') {
                    // Remove from order book since it's fully filled
                    await this.redisService.removeOrderFromBook(
                        instrument,
                        update.side,
                        update.order_id,
                        new Date(update.created_at).getTime()
                    );
                } else if (update.status === 'partially_filled') {
                    // Update order status in Redis
                    await this.redisService.updateOrderStatus(
                        update.order_id,
                        update.status,
                        update.filled_quantity
                    );
                }
            }

            console.log(`🚀 Sell Order ${order_id} processed: ${matchResult.trades.length} trades executed`);

            return {
                success: true,
                message: 'Sell order created successfully',
                order: createdOrder,
                match_result: {
                    trades_executed: matchResult.trades.length,
                    trades: matchResult.trades,
                    orders_affected: matchResult.orderUpdates.length,
                    book_changes: matchResult.bookUpdates.length
                }
            };

        } catch (error) {
            console.error('Error creating sell order:', error);
            throw new Error(`Failed to create sell order: ${error.message}`);
        }
    }

    /**
     * Get sell orders with optional filtering
     * @param {Object} filters - Filter options
     * @returns {Object} List of sell orders
     */
    async getSellOrders(filters = {}) {
        try {
            const {
                client_id,
                instrument,
                status,
                limit = 100,
                offset = 0
            } = filters;

            // Build cache key for Redis
            const cacheKey = `sell_orders:${JSON.stringify(filters)}`;
            
            // Try to get from cache first
            try {
                const cached = await this.redisService.redis.get(cacheKey);
                if (cached) {
                    return {
                        success: true,
                        source: 'cache',
                        ...JSON.parse(cached)
                    };
                }
            } catch (cacheError) {
                console.warn('Redis cache error:', cacheError);
            }

            // Start building the query using QueryBuilder instance
            let query = new QueryBuilder(this.pool).table('orders').select('*').where('side', 'sell');

            // Apply filters
            if (client_id) {
                query = query.where('client_id', client_id);
            }

            if (instrument) {
                query = query.where('instrument', instrument);
            }

            if (status) {
                query = query.where('status', status);
            }

            // Add ordering and pagination
            query = query.order_by('created_at', 'DESC').limit(limit, offset);

            // Execute query
            const orders = await query.get();

            // Get total count for pagination (without limit/offset)
            let countQuery = new QueryBuilder(this.pool).table('orders').select('COUNT(*) as total').where('side', 'sell');
            
            if (client_id) {
                countQuery = countQuery.where('client_id', client_id);
            }
            if (instrument) {
                countQuery = countQuery.where('instrument', instrument);
            }
            if (status) {
                countQuery = countQuery.where('status', status);
            }

            const countResult = await countQuery.get();
            const total = countResult[0]?.total || 0;

            const result = {
                orders,
                pagination: {
                    total,
                    limit,
                    offset,
                    hasMore: (offset + limit) < total
                },
                filters: {
                    client_id: client_id || null,
                    instrument: instrument || null,
                    status: status || null
                }
            };

            // Cache the result for 60 seconds
            try {
                await this.redisService.redis.setEx(
                    cacheKey, 
                    60, 
                    JSON.stringify(result)
                );
            } catch (cacheError) {
                console.warn('Redis cache set error:', cacheError);
            }

            return {
                success: true,
                source: 'database',
                ...result
            };

        } catch (error) {
            console.error('Error getting sell orders:', error);
            throw new Error(`Failed to get sell orders: ${error.message}`);
        }
    }

    /**
     * Create a buy order
     * @param {Object} orderData - Order data from request body
     * @returns {Object} Created order with generated UUID
     */
    async createBuyOrder(orderData) {
        try {
            const {
                client_id,
                instrument,
                type,
                price,
                quantity,
                filled_quantity = 0,
                status = 'open'
            } = orderData;

            // Generate server-side UUID for order_id
            const order_id = randomUUID();
            
            // Validate required fields
            if (!client_id || !instrument || !type || !quantity) {
                throw new Error('Missing required fields: client_id, instrument, type, quantity');
            }

            // Validate order type
            if (!['limit', 'market'].includes(type)) {
                throw new Error('Order type must be either "limit" or "market"');
            }

            // Validate price for limit orders
            if (type === 'limit' && (!price || price <= 0)) {
                throw new Error('Price is required and must be greater than 0 for limit orders');
            }

            // Validate quantity
            if (quantity <= 0) {
                throw new Error('Quantity must be greater than 0');
            }

            // Validate status
            const validStatuses = ['open', 'partially_filled', 'filled', 'cancelled', 'rejected'];
            if (!validStatuses.includes(status)) {
                throw new Error(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
            }

            // Set side as buy (as per requirement)
            const side = 'buy';

            // Prepare order data for insertion
            const orderToInsert = {
                order_id,
                client_id,
                instrument,
                side,
                type,
                price: type === 'limit' ? price : null, // Price is null for market orders
                quantity,
                filled_quantity,
                status
            };

            // Insert order into database using query builder
            const insertResult = await DB.insert('orders', orderToInsert);

            if (!insertResult.success) {
                throw new Error('Failed to insert order into database');
            }

            // Construct the created order response (no extra DB fetch for performance)
            // Timestamps will be within milliseconds of actual DB values
            const now = new Date();
            const createdOrder = {
                ...orderToInsert,
                created_at: now,
                updated_at: now
            };

            // Cache the order in Redis using the dedicated method
            await this.redisService.storeOrderDetails(order_id, createdOrder);

            // Add order to the orderbook (only for limit orders that are open/partially_filled)
            if (type === 'limit' && ['open', 'partially_filled'].includes(status)) {
                await this.redisService.addOrderToBook(
                    instrument,
                    side,
                    parseFloat(price),
                    order_id,
                    now.getTime() // Timestamp in milliseconds
                );
            }

            // *** RUN MATCHING ENGINE FOR BUY ORDERS! ***
            const matchResult = await this.matchingEngine.processOrder(createdOrder);

            // createdOrder is now updated by matching engine (passed by reference)
            // Update Redis with final order state
            await this.redisService.storeOrderDetails(order_id, createdOrder);

            // Add recent trades to Redis for fast access
            for (const trade of matchResult.trades) {
                await this.redisService.addRecentTrade(instrument, trade);
            }

            // Remove filled orders from Redis order book
            for (const update of matchResult.orderUpdates) {
                if (update.status === 'filled') {
                    // Remove from order book since it's fully filled
                    await this.redisService.removeOrderFromBook(
                        instrument,
                        update.side,
                        update.order_id,
                        new Date(update.created_at).getTime()
                    );
                } else if (update.status === 'partially_filled') {
                    // Update order status in Redis
                    await this.redisService.updateOrderStatus(
                        update.order_id,
                        update.status,
                        update.filled_quantity
                    );
                }
            }

            console.log(`🚀 Buy Order ${order_id} processed: ${matchResult.trades.length} trades executed`);

            return {
                success: true,
                message: 'Buy order created successfully',
                order: createdOrder,
                match_result: {
                    trades_executed: matchResult.trades.length,
                    trades: matchResult.trades,
                    orders_affected: matchResult.orderUpdates.length,
                    book_changes: matchResult.bookUpdates.length
                }
            };

        } catch (error) {
            console.error('Error creating buy order:', error);
            throw new Error(`Failed to create buy order: ${error.message}`);
        }
    }

    /**
     * Get buy orders with optional filtering
     * @param {Object} filters - Filter options
     * @returns {Object} List of buy orders
     */
    async getBuyOrders(filters = {}) {
        try {
            const {
                client_id,
                instrument,
                status,
                limit = 100,
                offset = 0
            } = filters;

            // Build cache key for Redis
            const cacheKey = `buy_orders:${JSON.stringify(filters)}`;
            
            // Try to get from cache first
            try {
                const cached = await this.redisService.redis.get(cacheKey);
                if (cached) {
                    return {
                        success: true,
                        source: 'cache',
                        ...JSON.parse(cached)
                    };
                }
            } catch (cacheError) {
                console.warn('Redis cache error:', cacheError);
            }

            // Start building the query using QueryBuilder instance
            let query = new QueryBuilder(this.pool).table('orders').select('*').where('side', 'buy');

            // Apply filters
            if (client_id) {
                query = query.where('client_id', client_id);
            }

            if (instrument) {
                query = query.where('instrument', instrument);
            }

            if (status) {
                query = query.where('status', status);
            }

            // Add ordering and pagination
            query = query.order_by('created_at', 'DESC').limit(limit, offset);

            // Execute query
            const orders = await query.get();

            // Get total count for pagination (without limit/offset)
            let countQuery = new QueryBuilder(this.pool).table('orders').select('COUNT(*) as total').where('side', 'buy');
            
            if (client_id) {
                countQuery = countQuery.where('client_id', client_id);
            }
            if (instrument) {
                countQuery = countQuery.where('instrument', instrument);
            }
            if (status) {
                countQuery = countQuery.where('status', status);
            }

            const countResult = await countQuery.get();
            const total = countResult[0]?.total || 0;

            const result = {
                orders,
                pagination: {
                    total,
                    limit,
                    offset,
                    hasMore: (offset + limit) < total
                },
                filters: {
                    client_id: client_id || null,
                    instrument: instrument || null,
                    status: status || null
                }
            };

            // Cache the result for 60 seconds
            try {
                await this.redisService.redis.setEx(
                    cacheKey, 
                    60, 
                    JSON.stringify(result)
                );
            } catch (cacheError) {
                console.warn('Redis cache set error:', cacheError);
            }

            return {
                success: true,
                source: 'database',
                ...result
            };

        } catch (error) {
            console.error('Error getting buy orders:', error);
            throw new Error(`Failed to get buy orders: ${error.message}`);
        }
    }

    /**
     * Get all orders with optional filtering
     * @param {Object} filters - Filter options
     * @returns {Object} List of all orders
     */
    async getAllOrders(filters = {}) {
        try {
            const {
                client_id,
                instrument,
                side,
                status,
                type,
                limit = 100,
                offset = 0
            } = filters;

            // Build cache key for Redis
            const cacheKey = `all_orders:${JSON.stringify(filters)}`;
            
            // Try to get from cache first
            try {
                const cached = await this.redisService.redis.get(cacheKey);
                if (cached) {
                    return {
                        success: true,
                        source: 'cache',
                        ...JSON.parse(cached)
                    };
                }
            } catch (cacheError) {
                console.warn('Redis cache error:', cacheError);
            }

            // Start building the query using QueryBuilder instance
            let query = new QueryBuilder(this.pool).table('orders').select('*');

            // Apply filters
            if (client_id) {
                query = query.where('client_id', client_id);
            }

            if (instrument) {
                query = query.where('instrument', instrument);
            }

            if (side) {
                query = query.where('side', side);
            }

            if (status) {
                query = query.where('status', status);
            }

            if (type) {
                query = query.where('type', type);
            }

            // Add ordering and pagination
            query = query.order_by('created_at', 'DESC').limit(limit, offset);

            // Execute query
            const orders = await query.get();

            // Get total count for pagination (without limit/offset)
            let countQuery = new QueryBuilder(this.pool).table('orders').select('COUNT(*) as total');
            
            if (client_id) {
                countQuery = countQuery.where('client_id', client_id);
            }
            if (instrument) {
                countQuery = countQuery.where('instrument', instrument);
            }
            if (side) {
                countQuery = countQuery.where('side', side);
            }
            if (status) {
                countQuery = countQuery.where('status', status);
            }
            if (type) {
                countQuery = countQuery.where('type', type);
            }

            const countResult = await countQuery.get();
            const total = countResult[0]?.total || 0;

            const result = {
                orders,
                pagination: {
                    total,
                    limit,
                    offset,
                    hasMore: (offset + limit) < total
                },
                filters: {
                    client_id: client_id || null,
                    instrument: instrument || null,
                    side: side || null,
                    status: status || null,
                    type: type || null
                }
            };

            // Cache the result for 60 seconds
            try {
                await this.redisService.redis.setEx(
                    cacheKey, 
                    60, 
                    JSON.stringify(result)
                );
            } catch (cacheError) {
                console.warn('Redis cache set error:', cacheError);
            }

            return {
                success: true,
                source: 'database',
                ...result
            };

        } catch (error) {
            console.error('Error getting all orders:', error);
            throw new Error(`Failed to get all orders: ${error.message}`);
        }
    }
}

module.exports = OrderServices;
