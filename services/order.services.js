const { randomUUID } = require('crypto');
const { DB, QueryBuilder } = require('../db/query');

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
}

module.exports = OrderServices;
