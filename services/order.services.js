const { randomUUID } = require('crypto');
const { DB, QueryBuilder } = require('../db/query');
const MatchingEngine = require('../helper/matcher');

/**
 * Order Services
 * Handles order creation and management for trading system
 */

class OrderServices {
    constructor(pool, redisService) {
        this.pool = pool;
        this.redisService = redisService;
        
        // Initialize DB with the pool
        DB.init(pool);
        
        // Initialize matching engine
        this.matchingEngine = new MatchingEngine(pool, redisService);
    }

    /**
     * Initialize the order services and matching engine
     */
    async initialize() {
        try {
            await this.matchingEngine.initialize();
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
            const {
                order_id,
                client_id,
                instrument,
                side,
                type,
                price,
                quantity,
                filled_quantity = 0,
                status = 'open'
            } = orderData;

            // Check idempotency if key provided
            if (idempotencyKey) {
                const cacheKey = `idempotency:${idempotencyKey}`;
                const cached = await this.redisService.redis.get(cacheKey);
                if (cached) {
                    return JSON.parse(cached);
                }
            }

            // Validate required fields
            if (!client_id || !instrument || !side || !type || !quantity) {
                throw new Error('Missing required fields: client_id, instrument, side, type, quantity');
            }

            // Validate side
            if (!['buy', 'sell'].includes(side)) {
                throw new Error('Side must be either "buy" or "sell"');
            }

            // Validate order type
            if (!['limit', 'market'].includes(type)) {
                throw new Error('Order type must be either "limit" or "market"');
            }

            // Validate and parse quantity
            const parsedQuantity = parseFloat(quantity);
            if (isNaN(parsedQuantity) || parsedQuantity <= 0) {
                throw new Error('Quantity must be a valid number greater than 0');
            }

            // Validate and parse price for limit orders
            let parsedPrice = null;
            if (type === 'limit') {
                parsedPrice = parseFloat(price);
                if (isNaN(parsedPrice) || parsedPrice <= 0) {
                    throw new Error('Price must be a valid number greater than 0 for limit orders');
                }
            }

            // Parse filled_quantity and ensure it's a valid decimal
            const parsedFilledQuantity = parseFloat(filled_quantity) || 0;
            if (isNaN(parsedFilledQuantity) || parsedFilledQuantity < 0) {
                throw new Error('Filled quantity must be a valid number >= 0');
            }

            // Generate server-side UUID for order_id if not provided
            const finalOrderId = order_id || randomUUID();

            // Prepare order data for insertion with properly parsed numbers
            const orderToInsert = {
                order_id: finalOrderId,
                client_id,
                instrument,
                side,
                type,
                price: parsedPrice ? parseFloat(parsedPrice.toFixed(8)) : null,
                quantity: parseFloat(parsedQuantity.toFixed(8)),
                filled_quantity: parseFloat(parsedFilledQuantity.toFixed(8)),
                status
            };

            // Insert order into database first
            const insertResult = await DB.insert('orders', orderToInsert);
            if (!insertResult.success) {
                throw new Error('Failed to insert order into database');
            }

            // Fetch the created order with timestamps
            const createdOrder = await DB.find_one('orders', { order_id: finalOrderId });

            // *** THIS IS WHERE THE MATCHING ALGORITHM RUNS! ***
            const matchResult = await this.matchingEngine.processOrder(createdOrder);

            // Prepare response
            const response = {
                success: true,
                message: `${side.charAt(0).toUpperCase() + side.slice(1)} order created successfully`,
                order: await DB.find_one('orders', { order_id: finalOrderId }), // Get updated order
                match_result: {
                    trades_executed: matchResult.trades.length,
                    trades: matchResult.trades,
                    orders_affected: matchResult.orderUpdates.length,
                    book_changes: matchResult.bookUpdates.length
                }
            };

            // Cache the order in Redis
            const cacheKey = `order:${finalOrderId}`;
            await this.redisService.redis.setEx(
                cacheKey, 
                300, // 5 minutes TTL
                JSON.stringify(response.order)
            );

            // Cache idempotency result if key provided
            if (idempotencyKey) {
                const idempotencyCacheKey = `idempotency:${idempotencyKey}`;
                await this.redisService.redis.setEx(
                    idempotencyCacheKey,
                    3600, // 1 hour TTL
                    JSON.stringify(response)
                );
            }

            // Log the matching result
            console.log(`Order ${finalOrderId} processed: ${matchResult.trades.length} trades executed`);

            return response;

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
            // Try cache first
            const cacheKey = `order:${orderId}`;
            const cached = await this.redisService.redis.get(cacheKey);
            if (cached) {
                return {
                    success: true,
                    source: 'cache',
                    order: JSON.parse(cached)
                };
            }

            // Get from database
            const order = await DB.find_one('orders', { order_id: orderId });
            if (!order) {
                throw new Error('Order not found');
            }

            // Cache it
            await this.redisService.redis.setEx(cacheKey, 300, JSON.stringify(order));

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
            const orderBook = this.matchingEngine.getOrderBookDepth(instrument, levels);
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

            query = query.order_by('timestamp', 'DESC').limit(limit, offset);

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

            return {
                success: true,
                message: 'Sell order created successfully',
                order: createdOrder
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

            return {
                success: true,
                message: 'Buy order created successfully',
                order: createdOrder
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
