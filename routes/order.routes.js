const express = require('express');
const OrderServices = require('../services/order.services');

const router = express.Router();

/**
 * Get order services helper
 * Uses pre-initialized instance from server startup, or creates one if needed
 */
async function getOrderServices(req) {
    // Try to get pre-initialized instance from app.locals (created on server startup)
    let orderServicesInstance = req.app.locals.orderServices;
    
    // Fallback: create new instance if not pre-initialized (for testing or edge cases)
    if (!orderServicesInstance) {
        const pool = req.app.locals.pool;
        const redisService = req.app.locals.redisService;
        const snapshotService = req.app.locals.snapshotService;

        if (!pool || !redisService) {
            throw new Error('Database or Redis service not available');
        }

        orderServicesInstance = new OrderServices(pool, redisService, snapshotService);
        await orderServicesInstance.initialize();
    }
    return orderServicesInstance;
}

/**
 * POST /orders
 * Create a new order (unified endpoint as per assignment requirements)
 * This is where the matching algorithm runs!
 * 
 * Expected request body:
 * {
 *   "idempotency_key": "string (optional)",
 *   "order_id": "string (optional, server generates if not provided)",
 *   "client_id": "string",
 *   "instrument": "string (e.g., BTC-USD)",
 *   "side": "buy | sell",
 *   "type": "limit | market",
 *   "price": "number (required for limit orders)",
 *   "quantity": "number"
 * }
 */
router.post('/orders', async (req, res) => {
    try {
        // Get idempotency key from header or body
        const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotency_key;

        // Initialize order services
        const orderServices = await getOrderServices(req);

        // Validate request body
        if (!req.body || Object.keys(req.body).length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Request body is required'
            });
        }

        // Create order (this triggers the matching engine!)
        const result = await orderServices.createOrder(req.body, idempotencyKey);

        // Return success response
        res.status(201).json(result);

    } catch (error) {
        console.error('Error in /orders endpoint:', error);

        // Handle validation errors vs server errors
        const statusCode = error.message.includes('Missing required fields') ||
            error.message.includes('must be') ||
            error.message.includes('Invalid') ? 400 : 500;

        res.status(statusCode).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /orders/{order_id}/cancel
 * Cancel an existing order
 */
router.post('/orders/:order_id/cancel', async (req, res) => {
    try {
        const { order_id } = req.params;

        if (!order_id) {
            return res.status(400).json({
                success: false,
                error: 'Order ID is required'
            });
        }

        const orderServices = await getOrderServices(req);
        const result = await orderServices.cancelOrder(order_id);

        res.status(200).json(result);

    } catch (error) {
        console.error('Error in /orders/:order_id/cancel endpoint:', error);

        const statusCode = error.message.includes('not found') ? 404 : 500;

        res.status(statusCode).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /orders/{order_id}
 * Get order status by ID
 */
router.get('/orders/:order_id', async (req, res) => {
    try {
        const { order_id } = req.params;

        if (!order_id) {
            return res.status(400).json({
                success: false,
                error: 'Order ID is required'
            });
        }

        const orderServices = await getOrderServices(req);
        const result = await orderServices.getOrderById(order_id);

        res.status(200).json(result);

    } catch (error) {
        console.error('Error in /orders/:order_id endpoint:', error);

        const statusCode = error.message.includes('not found') ? 404 : 500;

        res.status(statusCode).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /orderbook
 * Get current order book state
 * 
 * Query parameters:
 * - instrument: Trading instrument (default: BTC-USD)
 * - levels: Number of price levels (default: 20)
 */
router.get('/orderbook', async (req, res) => {
    try {
        const {
            instrument = 'BTC-USD',
            levels = 20
        } = req.query;

        const orderServices = await getOrderServices(req);
        const result = await orderServices.getOrderBook(instrument, parseInt(levels));
        console.log(result);
        res.status(200).json(result);

    } catch (error) {
        console.error('Error in /orderbook endpoint:', error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /trades
 * Get recent trades
 * 
 * Query parameters:
 * - instrument: Filter by instrument
 * - limit: Number of trades to return (default: 50)
 * - offset: Pagination offset (default: 0)
 */
router.get('/trades', async (req, res) => {
    try {
        const {
            instrument,
            limit = 50,
            offset = 0
        } = req.query;

        const orderServices = await getOrderServices(req);
        const result = await orderServices.getTrades({
            instrument,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });

        res.status(200).json(result);

    } catch (error) {
        console.error('Error in /trades endpoint:', error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /sell
 * Create a sell order
 * 
 * Expected request body:
 * {
 *   "client_id": "string",
 *   "instrument": "string (e.g., BTC-USD)",
 *   "type": "limit | market",
 *   "price": "number (required for limit orders)",
 *   "quantity": "number",
 *   "filled_quantity": "number (optional, defaults to 0)",
 *   "status": "open | partially_filled | filled | cancelled | rejected (optional, defaults to 'open')"
 * }
 * 
 * Note: order_id is server-generated UUID, side is automatically set to 'sell'
 * created_at and updated_at are automatically set by database
 */
router.post('/sell', async (req, res) => {
    try {
        // Get database pool and redis service from app locals
        const pool = req.app.locals.pool;
        const redisService = req.app.locals.redisService;

        if (!pool || !redisService) {
            return res.status(500).json({
                success: false,
                error: 'Database or Redis service not available'
            });
        }

        // Initialize order services with pool and redis service
        const orderServices = new OrderServices(pool, redisService);

        // Validate request body
        if (!req.body || Object.keys(req.body).length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Request body is required'
            });
        }

        // Create sell order
        const result = await orderServices.createSellOrder(req.body);

        // Return success response
        res.status(201).json(result);

    } catch (error) {
        console.error('Error in /sell endpoint:', error);

        // Handle validation errors vs server errors
        const statusCode = error.message.includes('Missing required fields') ||
            error.message.includes('must be') ||
            error.message.includes('Invalid') ? 400 : 500;

        res.status(statusCode).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /sell
 * Retrieve sell orders
 * 
 * Query parameters (optional):
 * - client_id: Filter by client ID
 * - instrument: Filter by instrument (e.g., BTC-USD)
 * - status: Filter by status (open, partially_filled, filled, cancelled, rejected)
 * - limit: Limit number of results (default: 100, max: 1000)
 * - offset: Offset for pagination (default: 0)
 */
router.get('/sell', async (req, res) => {
    try {
        // Get database pool and redis service from app locals
        const pool = req.app.locals.pool;
        const redisService = req.app.locals.redisService;

        if (!pool || !redisService) {
            return res.status(500).json({
                success: false,
                error: 'Database or Redis service not available'
            });
        }

        // Initialize order services with pool and redis service
        const orderServices = new OrderServices(pool, redisService);

        // Get query parameters
        const {
            client_id,
            instrument,
            status,
            limit = 100,
            offset = 0
        } = req.query;

        // Get sell orders
        const result = await orderServices.getSellOrders({
            client_id,
            instrument,
            status,
            limit: Math.min(parseInt(limit) || 100, 1000), // Max 1000 records
            offset: parseInt(offset) || 0
        });

        // Return success response
        res.status(200).json(result);

    } catch (error) {
        console.error('Error in GET /sell endpoint:', error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /buy
 * Create a buy order
 * 
 * Expected request body:
 * {
 *   "client_id": "string",
 *   "instrument": "string (e.g., BTC-USD)",
 *   "type": "limit | market",
 *   "price": "number (required for limit orders)",
 *   "quantity": "number",
 *   "filled_quantity": "number (optional, defaults to 0)",
 *   "status": "open | partially_filled | filled | cancelled | rejected (optional, defaults to 'open')"
 * }
 * 
 * Note: order_id is server-generated UUID, side is automatically set to 'buy'
 * created_at and updated_at are automatically set by database
 */
router.post('/buy', async (req, res) => {
    try {
        // Get database pool and redis service from app locals
        const pool = req.app.locals.pool;
        const redisService = req.app.locals.redisService;

        if (!pool || !redisService) {
            return res.status(500).json({
                success: false,
                error: 'Database or Redis service not available'
            });
        }

        // Initialize order services with pool and redis service
        const orderServices = new OrderServices(pool, redisService);

        // Validate request body
        if (!req.body || Object.keys(req.body).length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Request body is required'
            });
        }

        // Create buy order
        const result = await orderServices.createBuyOrder(req.body);

        // Return success response
        res.status(201).json(result);

    } catch (error) {
        console.error('Error in /buy endpoint:', error);

        // Handle validation errors vs server errors
        const statusCode = error.message.includes('Missing required fields') ||
            error.message.includes('must be') ||
            error.message.includes('Invalid') ? 400 : 500;

        res.status(statusCode).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /buy
 * Retrieve buy orders
 * 
 * Query parameters (optional):
 * - client_id: Filter by client ID
 * - instrument: Filter by instrument (e.g., BTC-USD)
 * - status: Filter by status (open, partially_filled, filled, cancelled, rejected)
 * - limit: Limit number of results (default: 100, max: 1000)
 * - offset: Offset for pagination (default: 0)
 */
router.get('/buy', async (req, res) => {
    try {
        // Get database pool and redis service from app locals
        const pool = req.app.locals.pool;
        const redisService = req.app.locals.redisService;

        if (!pool || !redisService) {
            return res.status(500).json({
                success: false,
                error: 'Database or Redis service not available'
            });
        }

        // Initialize order services with pool and redis service
        const orderServices = new OrderServices(pool, redisService);

        // Get query parameters
        const {
            client_id,
            instrument,
            status,
            limit = 100,
            offset = 0
        } = req.query;

        // Get buy orders
        const result = await orderServices.getBuyOrders({
            client_id,
            instrument,
            status,
            limit: Math.min(parseInt(limit) || 100, 1000), // Max 1000 records
            offset: parseInt(offset) || 0
        });

        // Return success response
        res.status(200).json(result);

    } catch (error) {
        console.error('Error in GET /buy endpoint:', error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /all
 * Retrieve all orders (both buy and sell)
 * 
 * Query parameters (optional):
 * - client_id: Filter by client ID
 * - instrument: Filter by instrument (e.g., BTC-USD)
 * - side: Filter by side (buy, sell)
 * - status: Filter by status (open, partially_filled, filled, cancelled, rejected)
 * - type: Filter by type (limit, market)
 * - limit: Limit number of results (default: 100, max: 1000)
 * - offset: Offset for pagination (default: 0)
 */
router.get('/all', async (req, res) => {
    try {
        // Get database pool and redis service from app locals
        const pool = req.app.locals.pool;
        const redisService = req.app.locals.redisService;

        if (!pool || !redisService) {
            return res.status(500).json({
                success: false,
                error: 'Database or Redis service not available'
            });
        }

        // Initialize order services with pool and redis service
        const orderServices = new OrderServices(pool, redisService);

        // Get query parameters
        const {
            client_id,
            instrument,
            side,
            status,
            type,
            limit = 100,
            offset = 0
        } = req.query;

        // Get all orders
        const result = await orderServices.getAllOrders({
            client_id,
            instrument,
            side,
            status,
            type,
            limit: Math.min(parseInt(limit) || 100, 1000), // Max 1000 records
            offset: parseInt(offset) || 0
        });

        // Return success response
        res.status(200).json(result);

    } catch (error) {
        console.error('Error in GET /all endpoint:', error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
