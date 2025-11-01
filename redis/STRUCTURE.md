# Redis Module Structure

This document explains the organization and design principles of the Redis layer.

## 📐 Architecture Overview

The Redis module follows a **separation of concerns** pattern, dividing responsibilities into distinct files:

```
redis/
├── client.js           # Low-level connection management
├── RedisService.js     # High-level business logic
├── index.js            # Public API aggregator
└── test/
    └── redis.test.js   # Integration tests
```

This mirrors the structure of the `db/` directory for consistency.

## 🔧 Component Breakdown

### 1. `client.js` - Connection Layer

**Responsibility**: Managing Redis client lifecycle

**Key Functions**:
- `createRedisClient()` - Creates and configures client
- `healthCheck(client)` - Checks connection health
- `closeRedisClient(client)` - Graceful shutdown
- `initializeRedis(client)` - Setup default data structures

**Features**:
- Docker/local environment detection
- Automatic reconnection strategy
- Event listeners for connection lifecycle
- Error handling and logging

**Example**:
```javascript
const client = await createRedisClient();
// Client is connected, events are attached, ready to use
```

### 2. `RedisService.js` - Business Logic Layer

**Responsibility**: High-level Redis operations for trading engine

**Key Features**:
- Order book management (ZSET operations)
- Order details storage (HASH operations)
- Trade history (LIST operations)
- Idempotency (STRING with TTL)
- Rate limiting (ZSET with sliding window)
- Metrics tracking (STRING counters)

**Design Principles**:
- **Encapsulation**: Internal Redis commands are hidden
- **Abstraction**: Methods use domain language (orders, trades, not ZSETs/HASHes)
- **Type Safety**: Clear input/output contracts
- **Error Handling**: All async operations wrapped in try-catch

**Example**:
```javascript
const service = new RedisService(client);
await service.addOrderToBook('BTC-USD', 'buy', 50000, 'order1', Date.now());
```

### 3. `index.js` - Public API

**Responsibility**: Aggregating exports and providing convenience functions

**Exports**:
- Connection functions from `client.js`
- `RedisService` class
- `createRedisService()` factory function

**Factory Pattern**:
```javascript
async function createRedisService() {
  const client = await createRedisClient();
  const service = new RedisService(client);
  await initializeRedis(client);
  return service;
}
```

**Benefits**:
- Single import point: `const { createRedisService } = require('./redis')`
- Hides initialization complexity
- Ensures proper setup sequence

## 🔄 Data Flow

### Initialization Flow

```
1. server.js calls createRedisService()
   ↓
2. index.js → createRedisClient()
   ↓
3. client.js creates client, attaches events, connects
   ↓
4. index.js → new RedisService(client)
   ↓
5. index.js → initializeRedis(client)
   ↓
6. Returns initialized RedisService to server.js
```

### Request Flow (Example: Add Order)

```
1. server.js: POST /orders
   ↓
2. redisService.addOrderToBook(...)
   ↓
3. RedisService.js converts to Redis command
   ↓
4. client.zAdd('orderbook:BTC-USD:buy', ...)
   ↓
5. Redis executes ZADD command
   ↓
6. Returns success to caller
```

## 🎯 Design Patterns

### 1. **Separation of Concerns**
- **client.js**: Infrastructure (connection, health, shutdown)
- **RedisService.js**: Business logic (orders, trades, metrics)
- **index.js**: Integration (factory, exports)

### 2. **Factory Pattern**
```javascript
// Instead of:
const client = await createRedisClient();
const service = new RedisService(client);
await initializeRedis(client);

// Use:
const service = await createRedisService();
```

### 3. **Service Layer Pattern**
- RedisService provides a clean API
- Hides Redis implementation details
- Easy to mock for testing
- Can swap Redis for another store without changing callers

### 4. **Dependency Injection**
```javascript
class RedisService {
  constructor(redisClient) {
    this.redis = redisClient; // Injected dependency
  }
}
```

Benefits:
- Testability (can inject mock client)
- Flexibility (can inject different client configs)
- Loose coupling

## 📊 Data Structure Choices

### Order Book → ZSET (Sorted Set)

**Why ZSET?**
- O(log N) insertion/deletion
- Automatic sorting by score (price)
- Range queries (get top N orders)
- Supports tie-breaking with member value (order_id:timestamp)

**Alternative Considered**: LIST
- ❌ No automatic sorting
- ❌ O(N) for insertion in sorted order
- ❌ Poor performance at scale

### Order Details → HASH

**Why HASH?**
- Field-level access (update status without fetching all fields)
- Efficient memory usage for small objects
- Native support for structured data

**Alternative Considered**: STRING (JSON)
- ❌ Must serialize/deserialize entire object
- ❌ Can't update individual fields
- ✅ Simpler for complex nested structures (not needed here)

### Recent Trades → LIST

**Why LIST?**
- FIFO queue semantics
- Efficient push/pop operations
- Can limit size with LTRIM

**Alternative Considered**: ZSET
- ❌ Overkill for simple recent trades
- ✅ Better if we need to query by timestamp range

### Idempotency Keys → STRING with TTL

**Why STRING?**
- Simple key-value lookup
- Built-in expiration (TTL)
- Atomic operations

### Rate Limiting → ZSET

**Why ZSET?**
- Sliding window algorithm
- Remove old entries efficiently (ZREMRANGEBYSCORE)
- Count current entries (ZCARD)

**Alternative Considered**: STRING counter
- ❌ Fixed window (not sliding)
- ❌ More edge cases around window boundaries

## 🔐 Best Practices Implemented

### 1. Connection Management
- ✅ Single client instance (connection pooling)
- ✅ Automatic reconnection
- ✅ Graceful shutdown
- ✅ Event-driven error handling

### 2. Memory Management
- ✅ TTLs on hot data (order details: 1h)
- ✅ Limited list sizes (trades: 100 items)
- ✅ Metrics without expiry (intentional for monitoring)

### 3. Error Handling
- ✅ Try-catch on all async operations
- ✅ Connection error events logged
- ✅ Health checks return structured errors

### 4. Performance
- ✅ Use appropriate data structures for access patterns
- ✅ Minimize round trips (get full order book in 2 calls)
- 🔄 TODO: Pipelining for batch operations

### 5. Testing
- ✅ Comprehensive test suite
- ✅ Cleanup after tests
- ✅ Real Redis instance (integration tests)

## 🔄 Future Enhancements

### 1. **Redis Clustering**
```javascript
// In client.js
const cluster = redis.createCluster({
  rootNodes: [
    { url: 'redis://redis-node1:6379' },
    { url: 'redis://redis-node2:6379' }
  ]
});
```

### 2. **Pipelining**
```javascript
async addMultipleOrders(orders) {
  const pipeline = this.redis.multi();
  for (const order of orders) {
    pipeline.zAdd(`orderbook:${order.instrument}:${order.side}`, {...});
  }
  await pipeline.exec();
}
```

### 3. **Lua Scripts**
```javascript
// Atomic matching operation
const matchScript = `
  local buy_key = KEYS[1]
  local sell_key = KEYS[2]
  -- ... matching logic ...
`;
await this.redis.eval(matchScript, [buyKey, sellKey]);
```

### 4. **Redis Streams**
```javascript
// For event sourcing
await this.redis.xAdd('order:events', '*', {
  type: 'ORDER_CREATED',
  order_id: 'order123',
  data: JSON.stringify(orderData)
});
```

## 📚 Related Documentation

- `db/STRUCTURE.md` - MySQL layer structure
- `redis/README.md` - Usage and API reference
- Root `README.md` - Overall project architecture

## 🤝 Contributing

When adding new Redis operations:

1. **Add to RedisService.js** if it's business logic
2. **Add to client.js** if it's infrastructure
3. **Update index.js** if exposing new exports
4. **Add tests** to `test/redis.test.js`
5. **Update README.md** with usage examples

