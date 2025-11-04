const express = require('express');
const router = express.Router();

/**
 * Health Check Routes
 * Separate from business logic - monitoring concerns
 */

/**
 * GET /healthz
 * Kubernetes-style health check endpoint
 * Used by load balancers and monitoring systems
 */
router.get('/healthz', async (req, res) => {
    try {
        const pool = req.app.locals.pool;
        const redisService = req.app.locals.redisService;

        if (!pool || !redisService) {
            return res.status(503).json({
                status: 'unhealthy',
                reason: 'Services not initialized',
                timestamp: new Date().toISOString()
            });
        }

        // Test database connection
        let dbStatus = 'disconnected';
        try {
            await pool.query('SELECT 1');
            dbStatus = 'connected';
        } catch (dbError) {
            console.warn('Database health check failed:', dbError.message);
        }

        // Test Redis connection
        let redisStatus = 'disconnected';
        try {
            const ping = await redisService.redis.ping();
            if (ping === 'PONG') {
                redisStatus = 'connected';
            }
        } catch (redisError) {
            console.warn('Redis health check failed:', redisError.message);
        }

        const isHealthy = dbStatus === 'connected' && redisStatus === 'connected';
        const statusCode = isHealthy ? 200 : 503;

        res.status(statusCode).json({
            status: isHealthy ? 'healthy' : 'unhealthy',
            timestamp: new Date().toISOString(),
            services: {
                database: dbStatus,
                redis: redisStatus
            }
        });
    } catch (error) {
        console.error('Health check error:', error);
        res.status(503).json({
            status: 'unhealthy',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * GET /health
 * Simple health check endpoint (for backwards compatibility)
 */
router.get('/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        message: 'Server is running',
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
