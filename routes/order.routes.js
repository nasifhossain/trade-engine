const express = require('express');
const OrderServices = require('../services/order.services');

const router = express.Router();

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

module.exports = router;
