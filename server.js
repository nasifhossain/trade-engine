const express = require('express');
const { DBForge } = require('./db');
const { createRedisService } = require('./redis');

// Import routes
const orderRoutes = require('./routes/order.routes');

const app = express();
app.use(express.json());

// MySQL Connection Pool - using DBForge
const pool = DBForge.createPoolFromEnv();

// Redis Service - will be initialized on server start
let redisService = null;

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', message: 'Server is healthy' });
});

// Root endpoint - Test Redis + MySQL connection
app.get('/', async (req, res) => {
    try {
        // Test Redis
        const testKey = 'test_key';
        await redisService.redis.set(testKey, 'Hello from Redis!');
        const redisValue = await redisService.redis.get(testKey);
        
        // Test MySQL
        const [rows] = await pool.query('SELECT 1 + 1 AS result');
        
        // Test Redis health
        const redisHealth = await redisService.healthCheck();
        
        res.json({
            message: "Get request received",
            redis: redisValue,
            mysql: rows[0].result,
            redis_healthy: redisHealth.healthy,
            status: "All services connected successfully"
        });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Use order routes
app.use('/api/orders', orderRoutes);

// Server startup with Redis initialization
async function startServer() {
    try {
        // Initialize Redis
        console.log('Initializing Redis...');
        redisService = await createRedisService();
        console.log('✓ Redis connected and ready');
        
        // Store in app.locals for use in routes
        app.locals.redisService = redisService;
        app.locals.pool = pool;
        
        // Start server
        const port = process.env.PORT || 3000;
        app.listen(port, () => {
            console.log(`✓ Server is running on port ${port}`);
            console.log(`✓ MySQL Host: ${process.env.MYSQL_HOST || 'localhost'}`);
            console.log(`✓ Redis Host: ${process.env.REDIS_HOST || 'localhost'}`);
            console.log(`✓ All services initialized successfully!`);
        });
    } catch (error) {
        console.error('✗ Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing gracefully...');
    const { closeRedisClient } = require('./redis/client');
    if (redisService && redisService.redis) {
        await closeRedisClient(redisService.redis);
    }
    await pool.end();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT received, closing gracefully...');
    const { closeRedisClient } = require('./redis/client');
    if (redisService && redisService.redis) {
        await closeRedisClient(redisService.redis);
    }
    await pool.end();
    process.exit(0);
});

// Start the server
startServer();