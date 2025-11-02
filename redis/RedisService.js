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
      created_at: orderData.created_at,
      updated_at: orderData.updated_at
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
}

module.exports = RedisService;

