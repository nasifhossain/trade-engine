const express = require('express');
const { DBForge } = require('./db');
const { createRedisService } = require('./redis');
const SnapshotService = require('./services/snapshot.services');
const OrderServices = require('./services/order.services');

// Import route modules
const orderRoutes = require('./routes/order.routes');

const app = express();
app.use(express.json());

// MySQL Connection Pool - using DBForge
const pool = DBForge.createPoolFromEnv();

// Redis Service - will be initialized on server start
let redisService = null;

// Snapshot Service - for fast recovery
let snapshotService = null;

// Order Services - will be initialized on server start
let orderServicesInstance = null;

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

// Mount route modules
app.use('/api/orders', orderRoutes);

// Server startup with Redis initialization
async function startServer() {
    try {
        // Initialize Redis
        console.log('Initializing Redis...');
        redisService = await createRedisService();
        console.log('✓ Redis connected and ready');
        
        // Initialize Snapshot Service
        console.log('Initializing Snapshot Service...');
        snapshotService = new SnapshotService(pool, redisService);
        
        // Configure snapshot service (customize based on environment)
        snapshotService.configure({
            enabled: process.env.SNAPSHOTS_ENABLED !== 'false', // Enable by default
            snapshotInterval: parseInt(process.env.SNAPSHOT_INTERVAL) || 5 * 60 * 1000, // 5 minutes
            retentionCount: parseInt(process.env.SNAPSHOT_RETENTION) || 10,
            instruments: (process.env.SNAPSHOT_INSTRUMENTS || 'BTC-USD,ETH-USD,SOL-USD').split(','),
            maxOrdersPerSnapshot: 100000
        });
        
        console.log('✓ Snapshot Service initialized');
        
        // Store in app.locals for use in routes
        app.locals.redisService = redisService;
        app.locals.pool = pool;
        app.locals.snapshotService = snapshotService;
        
        // Start periodic snapshots
        snapshotService.startPeriodicSnapshots();
        
        // Initialize Order Services (this loads data from MySQL/snapshots into Redis)
        console.log('Initializing Order Services and Matching Engine...');
        orderServicesInstance = new OrderServices(pool, redisService, snapshotService);
        await orderServicesInstance.initialize();
        console.log('✓ Order Services initialized - Redis order book loaded');
        
        // Store order services in app.locals for routes
        app.locals.orderServices = orderServicesInstance;
        
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
async function gracefulShutdown(signal) {
    console.log(`\n${signal} received, shutting down gracefully...`);
    
    try {
        // Create final snapshots before shutdown
        if (snapshotService) {
            console.log('Creating shutdown snapshots...');
            await snapshotService.createShutdownSnapshots();
            snapshotService.stopPeriodicSnapshots();
        }
        
        // Close Redis connection
        const { closeRedisClient } = require('./redis/client');
        if (redisService && redisService.redis) {
            console.log('Closing Redis connection...');
            await closeRedisClient(redisService.redis);
        }
        
        // Close MySQL pool
        console.log('Closing MySQL pool...');
        await pool.end();
        
        console.log('✓ Graceful shutdown complete');
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start the server
startServer();