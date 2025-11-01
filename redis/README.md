# Redis Layer - Trade Clearing Engine

This directory contains the Redis integration layer for the trade clearing and analytics engine. Redis is used for high-performance, in-memory data operations including order books, hot data caching, and real-time metrics.

## 📁 Directory Structure

```
redis/
├── client.js           # Redis connection management
├── RedisService.js     # High-level Redis operations
├── index.js            # Module exports and factory functions
├── test/
│   └── redis.test.js   # Comprehensive test suite
├── README.md           # This file
└── STRUCTURE.md        # Detailed architecture documentation
```

## 🚀 Quick Start

### Basic Usage

```javascript
const { createRedisService } = require('./redis');

// Initialize Redis service
const redisService = await createRedisService();

// Use the service
const orderBook = await redisService.getOrderBook('BTC-USD');
console.log(orderBook);

// Access raw client if needed
await redisService.redis.set('key', 'value');
```

### With Environment Variables

```env
# .env file
REDIS_HOST=redis          # Use 'redis' in Docker, 'localhost' for local
HOST_REDIS_PORT=6379      # Port for local connections
```

## 📊 Data Structures

### 1. Order Book (ZSET)

**Purpose**: Store buy/sell orders sorted by price-time priority

**Keys**:
- `orderbook:{instrument}:buy` - Buy orders
- `orderbook:{instrument}:sell` - Sell orders

**Structure**:
- **Score**: Price (negative for buy orders for reverse sort)
- **Member**: `{orderId}:{timestamp}`

**Operations**:
```javascript
// Add order
await redisService.addOrderToBook('BTC-USD', 'buy', 50000, 'order123', Date.now());

// Get top orders
const topBids = await redisService.getTopOrders('BTC-USD', 'buy', 10);

// Remove order
await redisService.removeOrderFromBook('BTC-USD', 'buy', 'order123', timestamp);
```

### 2. Order Details (HASH)

**Purpose**: Store complete order information for quick access

**Key**: `order:{orderId}`

**Fields**:
- `order_id`, `client_id`, `instrument`, `side`, `order_type`
- `price`, `quantity`, `filled_quantity`, `status`
- `created_at`, `updated_at`

**TTL**: 1 hour (3600 seconds)

**Operations**:
```javascript
// Store order
await redisService.storeOrderDetails('order123', orderData);

// Retrieve order
const order = await redisService.getOrderDetails('order123');

// Update status
await redisService.updateOrderStatus('order123', 'filled', 1.5);
```

### 3. Recent Trades (LIST)

**Purpose**: Keep a rolling list of recent trades per instrument

**Key**: `trades:{instrument}`

**Structure**: FIFO queue (limited to 100 most recent)

**Operations**:
```javascript
// Add trade
await redisService.addRecentTrade('BTC-USD', tradeData);

// Get recent trades
const trades = await redisService.getRecentTrades('BTC-USD', 20);
```

### 4. Idempotency Keys (STRING)

**Purpose**: Prevent duplicate order submissions

**Key**: `idempotency:{key}`

**Value**: Order ID

**TTL**: 24 hours (86400 seconds)

**Operations**:
```javascript
// Check if key exists
const orderId = await redisService.checkIdempotencyKey('key123');

// Store key
await redisService.storeIdempotencyKey('key123', 'order456', 86400);
```

### 5. Rate Limiting (ZSET)

**Purpose**: Track client request rates using sliding window

**Key**: `ratelimit:{clientId}`

**Structure**: 
- **Score**: Timestamp (ms)
- **Member**: Request identifier

**Operations**:
```javascript
// Check rate limit (100 requests per 60 seconds)
const result = await redisService.checkRateLimit('client123', 100, 60);
if (!result.allowed) {
  // Rate limit exceeded
}
```

### 6. Metrics (STRING)

**Purpose**: Store and increment application metrics

**Key**: `metrics:{metricName}`

**Value**: Counter value

**Operations**:
```javascript
// Increment metric
await redisService.incrementMetric('orders:created', 1);

// Get metric
const count = await redisService.getMetric('orders:created');

// Get all metrics
const allMetrics = await redisService.getAllMetrics('metrics:*');
```

## 🔧 API Reference

### Connection Management

#### `createRedisClient()`
Creates and connects a Redis client with auto-reconnection.

```javascript
const { createRedisClient } = require('./redis');
const client = await createRedisClient();
```

#### `closeRedisClient(client)`
Gracefully closes Redis connection.

```javascript
await closeRedisClient(client);
```

#### `healthCheck(client)`
Performs health check on Redis connection.

```javascript
const health = await healthCheck(client);
// { healthy: true, latency: '5ms', connected: true }
```

### RedisService Methods

See `RedisService.js` for complete method documentation. Key methods:

- **Order Book**: `addOrderToBook()`, `removeOrderFromBook()`, `getTopOrders()`, `getOrderBook()`
- **Orders**: `storeOrderDetails()`, `getOrderDetails()`, `updateOrderStatus()`
- **Trades**: `addRecentTrade()`, `getRecentTrades()`
- **Idempotency**: `checkIdempotencyKey()`, `storeIdempotencyKey()`
- **Rate Limiting**: `checkRateLimit()`
- **Metrics**: `incrementMetric()`, `getMetric()`, `getAllMetrics()`
- **Utilities**: `clearInstrument()`, `getInfo()`

## 🧪 Testing

Run the comprehensive test suite:

```bash
# Run tests
node redis/test/redis.test.js

# Or with npm (if configured)
npm test redis/test/redis.test.js
```

Tests cover:
- Health checks
- Order book operations
- Order details storage
- Trade tracking
- Idempotency
- Rate limiting
- Metrics

## 🐳 Docker Integration

The Redis client automatically detects Docker environment:

```javascript
// Detects if REDIS_HOST === 'redis' (Docker)
const isDocker = process.env.REDIS_HOST === 'redis';
const host = isDocker ? 'redis' : 'localhost';
const port = isDocker ? 6379 : (process.env.HOST_REDIS_PORT || 6379);
```

## ⚡ Performance Considerations

1. **Order Book**: ZSET operations are O(log N), optimal for price-time priority
2. **Hot Data TTL**: Order details expire after 1 hour to prevent memory bloat
3. **Trade History**: Limited to 100 recent trades per instrument
4. **Connection Pooling**: Single client connection with auto-reconnect
5. **Pipeline Operations**: Use for batch operations (not yet implemented)

## 🔍 Monitoring

### Health Check
```javascript
const health = await redisService.healthCheck();
console.log(health);
// { healthy: true, latency: '3ms', connected: true }
```

### Redis Info
```javascript
const info = await redisService.getInfo();
console.log(info); // Full Redis INFO output
```

### Metrics Dashboard
```javascript
const metrics = await redisService.getAllMetrics();
console.log(metrics);
// {
//   'orders:created': 150,
//   'orders:filled': 120,
//   'orders:cancelled': 30
// }
```

## 🛠️ Troubleshooting

### Connection Issues

**Problem**: `Redis Client Error: ECONNREFUSED`

**Solution**:
```bash
# Check if Redis is running
docker ps | grep redis

# Restart Redis container
docker-compose restart redis

# Check environment variables
echo $REDIS_HOST
```

### Memory Issues

**Problem**: Redis memory usage growing

**Solution**:
```javascript
// Check memory
const info = await redisService.getInfo();

// Clear old data
await redisService.clearInstrument('BTC-USD');

// Monitor TTLs
await client.ttl('order:order123');
```

### Performance Issues

**Problem**: Slow Redis operations

**Solution**:
1. Check latency: `await redisService.healthCheck()`
2. Use `redis-cli` to check: `redis-cli --latency`
3. Consider enabling Redis persistence (AOF/RDB) for durability vs performance tradeoff

## 📚 Further Reading

- [Redis Data Structures](https://redis.io/docs/data-types/)
- [ZSET Commands](https://redis.io/commands/?group=sorted-set)
- [Redis Pipelining](https://redis.io/docs/manual/pipelining/)
- [Node Redis Client](https://github.com/redis/node-redis)

## 🔗 Related Files

- `db/` - MySQL persistence layer
- `server.js` - Express server integration
- `docker-compose.yml` - Container orchestration

