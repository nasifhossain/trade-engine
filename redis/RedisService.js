/**
 * RedisService - High-level Redis operations for the trading engine
 * 
 * This service provides methods for:
 * - Order book management (using ZSETs for price-time priority)
 * - Order details storage (using HASHes)
 * - Recent trades (using LISTs)
 * - Idempotency keys (using STRINGs with TTL)
 * - Rate limiting and hot data caching
 */

class RedisService {
  constructor(redisClient) {
    this.redis = redisClient;
  }

  /**
   * Health check for Redis connection
   * @returns {Promise<object>} Health status
   */
  async healthCheck() {
    try {
      const start = Date.now();
      await this.redis.ping();
      const latency = Date.now() - start;
      
      return {
        healthy: true,
        latency: `${latency}ms`,
        connected: this.redis.isOpen
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        connected: this.redis.isOpen
      };
    }
  }

  // ==================== ORDER BOOK OPERATIONS ====================
  
  /**
   * Add an order to the order book (buy or sell side)
   * Uses ZSET with score = price for buy (negative for proper sorting) or sell
   * Member = order_id:timestamp (for price-time priority)
   * 
   * @param {string} instrument - e.g., "BTC-USD"
   * @param {string} side - "buy" or "sell"
   * @param {number} price - Order price
   * @param {string} orderId - Unique order ID
   * @param {number} timestamp - Order timestamp (microseconds)
   */
  async addOrderToBook(instrument, side, price, orderId, timestamp) {
    const key = `orderbook:${instrument}:${side}`;
    const member = `${orderId}:${timestamp}`;
    
    // For buy orders, use negative price for reverse ordering (highest first)
    const score = side === 'buy' ? -price : price;
    
    await this.redis.zAdd(key, { score, value: member });
  }

  /**
   * Remove an order from the order book
   * @param {string} instrument - e.g., "BTC-USD"
   * @param {string} side - "buy" or "sell"
   * @param {string} orderId - Order ID
   * @param {number} timestamp - Order timestamp
   */
  async removeOrderFromBook(instrument, side, orderId, timestamp) {
    const key = `orderbook:${instrument}:${side}`;
    const member = `${orderId}:${timestamp}`;
    await this.redis.zRem(key, member);
  }

  /**
   * Get top N orders from one side of the order book
   * @param {string} instrument - e.g., "BTC-USD"
   * @param {string} side - "buy" or "sell"
   * @param {number} limit - Number of orders to retrieve
   * @returns {Promise<Array>} Array of {orderId, timestamp, price}
   */
  async getTopOrders(instrument, side, limit = 10) {
    const key = `orderbook:${instrument}:${side}`;
    
    // Get top N with scores
    const results = await this.redis.zRangeWithScores(key, 0, limit - 1);
    
    return results.map(item => {
      const [orderId, timestamp] = item.value.split(':');
      const price = side === 'buy' ? -item.score : item.score;
      return { orderId, timestamp: parseInt(timestamp), price };
    });
  }

  /**
   * Get full order book for an instrument
   * @param {string} instrument - e.g., "BTC-USD"
   * @param {number} depth - Number of levels on each side (default 20)
   * @returns {Promise<object>} {bids: [...], asks: [...]}
   */
  async getOrderBook(instrument, depth = 20) {
    const [bids, asks] = await Promise.all([
      this.getTopOrders(instrument, 'buy', depth),
      this.getTopOrders(instrument, 'sell', depth)
    ]);

    return { bids, asks };
  }

  // ==================== ORDER DETAILS OPERATIONS ====================
  
  /**
   * Store order details as a HASH
   * @param {string} orderId - Order ID
   * @param {object} orderData - Order details
   */
  async storeOrderDetails(orderId, orderData) {
    const key = `order:${orderId}`;
    
    // Convert object to flat hash structure
    // Redis HASH requires all values to be strings
    const hashData = {
      order_id: orderData.order_id,
      client_id: orderData.client_id,
      instrument: orderData.instrument,
      side: orderData.side,
      type: orderData.type,
      price: orderData.price?.toString() || '0',
      quantity: orderData.quantity.toString(),
      filled_quantity: orderData.filled_quantity?.toString() || '0',
      status: orderData.status,
      created_at: orderData.created_at instanceof Date 
        ? orderData.created_at.toISOString() 
        : orderData.created_at?.toString() || new Date().toISOString(),
      updated_at: orderData.updated_at instanceof Date 
        ? orderData.updated_at.toISOString() 
        : orderData.updated_at?.toString() || new Date().toISOString()
    };

    await this.redis.hSet(key, hashData);
    
    // Set TTL for hot data (e.g., 1 hour)
    await this.redis.expire(key, 3600);
  }

  /**
   * Get order details by order ID
   * @param {string} orderId - Order ID
   * @returns {Promise<object|null>} Order details or null if not found
   */
  async getOrderDetails(orderId) {
    const key = `order:${orderId}`;
    const data = await this.redis.hGetAll(key);
    
    if (Object.keys(data).length === 0) {
      return null;
    }

    // Parse numeric fields
    return {
      ...data,
      price: parseFloat(data.price),
      quantity: parseFloat(data.quantity),
      filled_quantity: parseFloat(data.filled_quantity)
    };
  }

  /**
   * Update order status and filled quantity
   * @param {string} orderId - Order ID
   * @param {string} status - New status
   * @param {number} filledQuantity - Updated filled quantity
   */
  async updateOrderStatus(orderId, status, filledQuantity) {
    const key = `order:${orderId}`;
    await this.redis.hSet(key, {
      status,
      filled_quantity: filledQuantity.toString(),
      updated_at: new Date().toISOString()
    });
  }

  // ==================== TRADE OPERATIONS ====================
  
  /**
   * Add a trade to the recent trades list (FIFO queue)
   * @param {string} instrument - e.g., "BTC-USD"
   * @param {object} trade - Trade details
   */
  async addRecentTrade(instrument, trade) {
    const key = `trades:${instrument}`;
    const tradeData = JSON.stringify({
      trade_id: trade.trade_id,
      buy_order_id: trade.buy_order_id,
      sell_order_id: trade.sell_order_id,
      price: trade.price,
      quantity: trade.quantity,
      executed_at: trade.executed_at
    });

    // Add to beginning of list
    await this.redis.lPush(key, tradeData);
    
    // Keep only last 100 trades
    await this.redis.lTrim(key, 0, 99);
  }

  /**
   * Get recent trades for an instrument
   * @param {string} instrument - e.g., "BTC-USD"
   * @param {number} limit - Number of trades to retrieve
   * @returns {Promise<Array>} Array of trade objects
   */
  async getRecentTrades(instrument, limit = 20) {
    const key = `trades:${instrument}`;
    const trades = await this.redis.lRange(key, 0, limit - 1);
    return trades.map(t => JSON.parse(t));
  }

  // ==================== IDEMPOTENCY OPERATIONS ====================
  
  /**
   * Check if an idempotency key exists
   * @param {string} idempotencyKey - Unique key for request
   * @returns {Promise<string|null>} Order ID if exists, null otherwise
   */
  async checkIdempotencyKey(idempotencyKey) {
    const key = `idempotency:${idempotencyKey}`;
    return await this.redis.get(key);
  }

  /**
   * Store an idempotency key with order ID
   * @param {string} idempotencyKey - Unique key for request
   * @param {string} orderId - Associated order ID
   * @param {number} ttl - TTL in seconds (default 24 hours)
   */
  async storeIdempotencyKey(idempotencyKey, orderId, ttl = 86400) {
    const key = `idempotency:${idempotencyKey}`;
    await this.redis.setEx(key, ttl, orderId);
  }

  // ==================== RATE LIMITING ====================
  
  /**
   * Check rate limit for a client
   * Uses sliding window counter
   * @param {string} clientId - Client ID
   * @param {number} limit - Max requests per window
   * @param {number} windowSeconds - Time window in seconds
   * @returns {Promise<object>} {allowed: boolean, remaining: number}
   */
  async checkRateLimit(clientId, limit = 100, windowSeconds = 60) {
    const key = `ratelimit:${clientId}`;
    const now = Date.now();
    const windowStart = now - (windowSeconds * 1000);

    // Remove old entries
    await this.redis.zRemRangeByScore(key, 0, windowStart);
    
    // Count current requests in window
    const count = await this.redis.zCard(key);
    
    if (count >= limit) {
      return { allowed: false, remaining: 0 };
    }

    // Add current request
    await this.redis.zAdd(key, { score: now, value: `${now}` });
    
    // Set expiry on key
    await this.redis.expire(key, windowSeconds);

    return { allowed: true, remaining: limit - count - 1 };
  }

  // ==================== METRICS & STATS ====================
  
  /**
   * Increment a counter metric
   * @param {string} metricName - Name of metric
   * @param {number} value - Value to increment by (default 1)
   */
  async incrementMetric(metricName, value = 1) {
    const key = `metrics:${metricName}`;
    await this.redis.incrBy(key, value);
  }

  /**
   * Get a metric value
   * @param {string} metricName - Name of metric
   * @returns {Promise<number>} Metric value
   */
  async getMetric(metricName) {
    const key = `metrics:${metricName}`;
    const value = await this.redis.get(key);
    return value ? parseInt(value) : 0;
  }

  /**
   * Get all metrics matching a pattern
   * @param {string} pattern - Pattern to match (e.g., "metrics:orders:*")
   * @returns {Promise<object>} Object with metric name => value
   */
  async getAllMetrics(pattern = 'metrics:*') {
    const keys = await this.redis.keys(pattern);
    const metrics = {};

    for (const key of keys) {
      const value = await this.redis.get(key);
      const metricName = key.replace('metrics:', '');
      metrics[metricName] = parseInt(value) || 0;
    }

    return metrics;
  }

  // ==================== UTILITY OPERATIONS ====================
  
  /**
   * Clear all data for an instrument (useful for testing)
   * @param {string} instrument - e.g., "BTC-USD"
   */
  async clearInstrument(instrument) {
    const keys = await this.redis.keys(`*${instrument}*`);
    if (keys.length > 0) {
      await this.redis.del(keys);
    }
  }

  /**
   * Get Redis info and stats
   * @returns {Promise<object>} Redis info
   */
  async getInfo() {
    const info = await this.redis.info();
    return info;
  }

  // ==================== PERSISTENCE QUEUE OPERATIONS ====================
  
  /**
   * Queue an operation for async database persistence
   * @param {string} type - Operation type ('order_create', 'trade', 'order_update')
   * @param {object} data - Operation data
   */
  async queuePersistence(type, data) {
    const key = 'persist:queue';
    const item = JSON.stringify({ type, data, timestamp: Date.now() });
    await this.redis.lPush(key, item);
  }

  /**
   * Get next batch of items from persistence queue
   * @param {number} batchSize - Number of items to retrieve
   * @returns {Promise<Array>} Batch of items to persist
   */
  async getPersistenceBatch(batchSize = 100) {
    const key = 'persist:queue';
    const items = await this.redis.lRange(key, 0, batchSize - 1);
    return items.map(item => JSON.parse(item));
  }

  /**
   * Remove persisted items from queue
   * @param {number} count - Number of items to remove
   */
  async removePersisted(count) {
    const key = 'persist:queue';
    await this.redis.lTrim(key, count, -1);
  }

  /**
   * Get persistence queue size
   * @returns {Promise<number>} Queue size
   */
  async getPersistenceQueueSize() {
    const key = 'persist:queue';
    return await this.redis.lLen(key);
  }

  // ==================== ORDER INDEXING OPERATIONS ====================
  
  /**
   * Add order to client index
   * @param {string} clientId - Client ID
   * @param {string} orderId - Order ID
   */
  async indexOrderByClient(clientId, orderId) {
    const key = `client:orders:${clientId}`;
    await this.redis.sAdd(key, orderId);
    await this.redis.expire(key, 86400);  // 24-hour TTL
  }

  /**
   * Add order to instrument index
   * @param {string} instrument - Instrument name
   * @param {string} orderId - Order ID
   */
  async indexOrderByInstrument(instrument, orderId) {
    const key = `instrument:orders:${instrument}`;
    await this.redis.sAdd(key, orderId);
    await this.redis.expire(key, 86400);
  }

  /**
   * Add order to status index
   * @param {string} status - Order status
   * @param {string} orderId - Order ID
   */
  async indexOrderByStatus(status, orderId) {
    const key = `order:status:${status}`;
    await this.redis.sAdd(key, orderId);
    await this.redis.expire(key, 86400);
  }

  /**
   * Get all orders for a client
   * @param {string} clientId - Client ID
   * @returns {Promise<Array>} Set of order IDs
   */
  async getClientOrders(clientId) {
    const key = `client:orders:${clientId}`;
    return await this.redis.sMembers(key);
  }

  /**
   * Get all orders for an instrument
   * @param {string} instrument - Instrument name
   * @returns {Promise<Array>} Set of order IDs
   */
  async getInstrumentOrders(instrument) {
    const key = `instrument:orders:${instrument}`;
    return await this.redis.sMembers(key);
  }

  /**
   * Get all orders with a specific status
   * @param {string} status - Order status
   * @returns {Promise<Array>} Set of order IDs
   */
  async getOrdersByStatus(status) {
    const key = `order:status:${status}`;
    return await this.redis.sMembers(key);
  }

  /**
   * Remove order from all indices
   * @param {string} clientId - Client ID
   * @param {string} instrument - Instrument name
   * @param {string} oldStatus - Previous status
   * @param {string} newStatus - New status
   * @param {string} orderId - Order ID
   */
  async updateOrderIndices(clientId, instrument, oldStatus, newStatus, orderId) {
    // Remove from old status index
    if (oldStatus) {
      const oldStatusKey = `order:status:${oldStatus}`;
      await this.redis.sRem(oldStatusKey, orderId);
    }
    
    // Add to new status index
    if (newStatus) {
      const newStatusKey = `order:status:${newStatus}`;
      await this.redis.sAdd(newStatusKey, orderId);
      await this.redis.expire(newStatusKey, 86400);
    }
  }

  /**
   * Create a snapshot of current order book state
   * @param {string} instrument - Instrument name
   * @param {object} bookData - Order book data
   */
  async createSnapshot(instrument, bookData) {
    const timestamp = Date.now();
    const key = `snapshot:${instrument}:${timestamp}`;
    const data = JSON.stringify({
      instrument,
      timestamp,
      bids: bookData.bids,
      asks: bookData.asks,
      spread: bookData.spread
    });
    
    await this.redis.set(key, data, { EX: 86400 });  // 24-hour TTL
    
    // Keep reference to latest snapshot
    await this.redis.set(`snapshot:${instrument}:latest`, key, { EX: 86400 });
    
    return key;
  }

  /**
   * Get latest snapshot for an instrument
   * @param {string} instrument - Instrument name
   * @returns {Promise<object|null>} Latest snapshot or null
   */
  async getLatestSnapshot(instrument) {
    const refKey = `snapshot:${instrument}:latest`;
    const snapshotKey = await this.redis.get(refKey);
    
    if (!snapshotKey) {
      return null;
    }
    
    const snapshotData = await this.redis.get(snapshotKey);
    return snapshotData ? JSON.parse(snapshotData) : null;
  }

  /**
   * Batch insert metrics
   * @param {object} metrics - Object with metric names and values
   */
  async batchIncrementMetrics(metrics) {
    for (const [name, value] of Object.entries(metrics)) {
      const key = `metrics:${name}`;
      await this.redis.incrBy(key, value);
    }
  }

  /**
   * Get all active instruments
   * @returns {Promise<Array>} List of instruments with orders
   */
  async getActiveInstruments() {
    const pattern = 'instrument:orders:*';
    const keys = await this.redis.keys(pattern);
    return keys.map(key => key.replace('instrument:orders:', ''));
  }

  /**
   * Get order book statistics
   * @returns {Promise<object>} Statistics about order book
   */
  async getOrderBookStats() {
    const instruments = await this.getActiveInstruments();
    const stats = {};
    
    for (const instrument of instruments) {
      const bidKey = `orderbook:${instrument}:buy`;
      const askKey = `orderbook:${instrument}:sell`;
      
      const bidCount = await this.redis.zCard(bidKey);
      const askCount = await this.redis.zCard(askKey);
      
      stats[instrument] = {
        bidOrders: bidCount,
        askOrders: askCount,
        totalOrders: bidCount + askCount
      };
    }
    
    return stats;
  }

  /**
   * Flush all trading data (use with caution!)
   * @param {string} instrument - Optional: flush specific instrument only
   */
  async flushTradingData(instrument = null) {
    if (instrument) {
      const pattern = `*${instrument}*`;
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        await this.redis.del(keys);
      }
    } else {
      // Clear all trading keys
      const patterns = [
        'orderbook:*',
        'order:*',
        'trades:*',
        'client:orders:*',
        'instrument:orders:*',
        'order:status:*',
        'snapshot:*'
      ];
      
      for (const pattern of patterns) {
        const keys = await this.redis.keys(pattern);
        if (keys.length > 0) {
          await this.redis.del(keys);
        }
      }
    }
  }

  /**
   * Get detailed diagnostics
   * @returns {Promise<object>} Diagnostics info
   */
  async getDiagnostics() {
    const instruments = await this.getActiveInstruments();
    const bookStats = await this.getOrderBookStats();
    const queueSize = await this.getPersistenceQueueSize();
    const health = await this.healthCheck();
    
    return {
      health,
      queueSize,
      instruments,
      bookStats,
      timestamp: new Date()
    };
  }

  // ==================== ADVANCED LOCKING OPERATIONS ====================

  /**
   * Acquire a distributed lock with automatic expiration
   * @param {string} lockKey - The lock key
   * @param {string} lockValue - Unique value to identify lock owner
   * @param {number} ttlSeconds - Lock TTL in seconds
   * @returns {Promise<boolean>} True if lock acquired
   */
  async acquireLock(lockKey, lockValue, ttlSeconds = 10) {
    try {
      const result = await this.redis.set(lockKey, lockValue, {
        NX: true,
        EX: ttlSeconds
      });
      return result === 'OK' || result === true;
    } catch (error) {
      console.error(`Error acquiring lock ${lockKey}:`, error);
      return false;
    }
  }

  /**
   * Release a lock only if we own it (using Lua script for atomicity)
   * @param {string} lockKey - The lock key
   * @param {string} lockValue - The value to verify ownership
   * @returns {Promise<boolean>} True if lock was released
   */
  async releaseLock(lockKey, lockValue) {
    try {
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      
      const result = await this.redis.eval(script, {
        keys: [lockKey],
        arguments: [lockValue]
      });
      
      return result === 1;
    } catch (error) {
      console.error(`Error releasing lock ${lockKey}:`, error);
      return false;
    }
  }

  /**
   * Extend lock expiration if we own it
   * @param {string} lockKey - The lock key
   * @param {string} lockValue - The value to verify ownership
   * @param {number} ttlSeconds - New TTL in seconds
   * @returns {Promise<boolean>} True if lock was extended
   */
  async extendLock(lockKey, lockValue, ttlSeconds = 10) {
    try {
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("expire", KEYS[1], ARGV[2])
        else
          return 0
        end
      `;
      
      const result = await this.redis.eval(script, {
        keys: [lockKey],
        arguments: [lockValue, ttlSeconds.toString()]
      });
      
      return result === 1;
    } catch (error) {
      console.error(`Error extending lock ${lockKey}:`, error);
      return false;
    }
  }

  /**
   * Check if a lock exists and who owns it
   * @param {string} lockKey - The lock key
   * @returns {Promise<string|null>} Lock value if exists, null otherwise
   */
  async checkLock(lockKey) {
    try {
      return await this.redis.get(lockKey);
    } catch (error) {
      console.error(`Error checking lock ${lockKey}:`, error);
      return null;
    }
  }

  /**
   * Get all active locks matching a pattern
   * @param {string} pattern - Pattern to match (e.g., "matching:lock:*")
   * @returns {Promise<Array>} Array of lock keys
   */
  async getActiveLocks(pattern = 'matching:lock:*') {
    try {
      const keys = await this.redis.keys(pattern);
      return keys;
    } catch (error) {
      console.error(`Error getting active locks:`, error);
      return [];
    }
  }

  /**
   * Force release all locks (use with caution!)
   * @param {string} pattern - Pattern to match (e.g., "matching:lock:*")
   * @returns {Promise<number>} Number of locks released
   */
  async forceReleaseAllLocks(pattern = 'matching:lock:*') {
    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        await this.redis.del(keys);
        return keys.length;
      }
      return 0;
    } catch (error) {
      console.error(`Error releasing locks:`, error);
      return 0;
    }
  }
}

module.exports = RedisService;

