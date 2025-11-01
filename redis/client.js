const redis = require('redis');

/**
 * Creates and configures a Redis client.
 * Automatically detects Docker environment for host/port.
 * Includes reconnection strategy and event listeners.
 * @returns {Promise<object>} Configured Redis client instance.
 */
async function createRedisClient() {
  // Detect if running in Docker (when REDIS_HOST is 'redis')
  const isDocker = process.env.REDIS_HOST === 'redis';
  const host = isDocker ? process.env.REDIS_HOST : 'localhost';
  const port = isDocker ? 6379 : (process.env.HOST_REDIS_PORT || 6379);

  console.log(`Connecting to Redis at ${host}:${port}`);

  const client = redis.createClient({
    socket: {
      host: host,
      port: parseInt(port),
      reconnectStrategy: (retries) => {
        const delay = Math.min(retries * 50, 3000);
        console.warn(`Redis reconnecting in ${delay}ms (attempt ${retries})`);
        return delay;
      }
    }
  });

  // Event listeners for connection lifecycle
  client.on('connect', () => console.log('✓ Redis Client: Connected'));
  client.on('ready', () => console.log('✓ Redis Client: Ready'));
  client.on('error', (err) => console.error('✗ Redis Client Error:', err.message));
  client.on('end', () => console.log('✗ Redis Client: Connection closed'));
  client.on('reconnecting', () => console.log('⚠ Redis Client: Reconnecting...'));

  await client.connect();
  return client;
}

/**
 * Performs a health check on the Redis client.
 * @param {object} client - Redis client instance
 * @returns {Promise<object>} Health check result
 */
async function healthCheck(client) {
  try {
    const start = Date.now();
    await client.ping();
    const latency = Date.now() - start;
    
    return {
      healthy: true,
      latency: `${latency}ms`,
      connected: client.isOpen
    };
  } catch (error) {
    return {
      healthy: false,
      error: error.message,
      connected: client.isOpen
    };
  }
}

/**
 * Gracefully closes the Redis client connection.
 * @param {object} client - Redis client instance
 */
async function closeRedisClient(client) {
  if (client && client.isOpen) {
    console.log('Closing Redis connection...');
    await client.quit();
    console.log('✓ Redis connection closed gracefully');
  }
}

/**
 * Initializes Redis with default data structures (if needed).
 * Can be used for setting up initial state on application start.
 * @param {object} client - Redis client instance
 */
async function initializeRedis(client) {
  try {
    // Example: Set up any default keys or data structures
    // This is a placeholder - customize based on your needs
    
    const initialized = await client.get('redis:initialized');
    if (!initialized) {
      console.log('Initializing Redis data structures...');
      await client.set('redis:initialized', new Date().toISOString());
      console.log('✓ Redis initialized');
    }
  } catch (error) {
    console.error('Redis initialization error:', error);
    throw error;
  }
}

module.exports = {
  createRedisClient,
  healthCheck,
  closeRedisClient,
  initializeRedis
};

