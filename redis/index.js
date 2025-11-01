/**
 * Redis Module - Main entry point
 * 
 * This module provides a clean interface for Redis operations:
 * - Connection management (client.js)
 * - Data operations (RedisService.js)
 * - Factory function for easy initialization
 */

const { createRedisClient, healthCheck, closeRedisClient, initializeRedis } = require('./client');
const RedisService = require('./RedisService');

/**
 * Factory function to create and initialize RedisService.
 * Handles client creation and connection.
 * @returns {Promise<RedisService>} An initialized RedisService instance.
 */
async function createRedisService() {
  const client = await createRedisClient();
  const service = new RedisService(client);
  
  // Optional: Initialize any default data structures
  await initializeRedis(client);
  
  return service;
}

module.exports = {
  // Client management
  createRedisClient,
  healthCheck,
  closeRedisClient,
  initializeRedis,
  
  // Service class
  RedisService,
  
  // Convenient factory
  createRedisService,
};

