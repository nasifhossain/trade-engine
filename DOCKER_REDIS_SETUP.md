# Docker Redis Integration - Quick Test Guide

This guide helps you verify that the Redis layer is properly integrated with your Docker setup.

## 🚀 Quick Start

### 1. Start Docker Services

```bash
# Start all services (MySQL, Redis, Node.js app, Nginx)
docker-compose up -d

# Check if all containers are running
docker ps
```

You should see:
- `twocents-app` (Node.js)
- `twocents-mysql` (MySQL)
- `twocents-redis` (Redis)
- `twocents-nginx` (Nginx)

### 2. Check Container Logs

```bash
# Check app logs
docker-compose logs app

# You should see:
# ✓ Redis connected and ready
# ✓ Server is running on port 3000
# ✓ All services initialized successfully!
```

### 3. Test the Health Endpoint

```bash
# Test via Nginx (port 80)
curl http://localhost/health

# Expected response:
# {"status":"OK","message":"Server is healthy"}
```

### 4. Test Redis Integration

```bash
# Test root endpoint (includes Redis + MySQL test)
curl http://localhost/

# Expected response (example):
# {
#   "message": "Get request received",
#   "redis": "Hello from Redis!",
#   "mysql": 2,
#   "redis_healthy": true,
#   "status": "All services connected successfully"
# }
```

## 🔍 Manual Redis Testing

### Connect to Redis Container

```bash
# Open Redis CLI
docker exec -it twocents-redis redis-cli

# Test basic commands
127.0.0.1:6379> PING
PONG

127.0.0.1:6379> GET test_key
"Hello from Redis!"

127.0.0.1:6379> KEYS *
1) "test_key"
2) "redis:initialized"

# Exit
127.0.0.1:6379> EXIT
```

### View Redis Data Structures

```bash
# In redis-cli, check order book
ZRANGE orderbook:BTC-USD:buy 0 -1 WITHSCORES

# Check order details
HGETALL order:order123

# Check recent trades
LRANGE trades:BTC-USD 0 -1
```

## 🧪 Run Redis Tests

```bash
# From your local machine (requires local Node.js)
node redis/test/redis.test.js

# Or inside Docker container
docker exec -it twocents-app node redis/test/redis.test.js
```

## 📊 Monitor Redis

### Check Redis Stats

```bash
# Connect to container
docker exec -it twocents-redis redis-cli

# Get info
INFO

# Check memory usage
INFO memory

# Check connected clients
INFO clients

# Check key statistics
INFO keyspace
```

### Monitor Real-Time Commands

```bash
# Watch all Redis commands in real-time
docker exec -it twocents-redis redis-cli MONITOR
```

## 🛠️ Troubleshooting

### Problem: App can't connect to Redis

**Check 1**: Verify Redis is running
```bash
docker ps | grep redis
```

**Check 2**: Check Redis logs
```bash
docker-compose logs redis
```

**Check 3**: Verify network connectivity
```bash
# From app container, ping Redis
docker exec -it twocents-app ping redis -c 3
```

**Check 4**: Verify environment variables
```bash
docker exec -it twocents-app printenv | grep REDIS
# Should show:
# REDIS_HOST=redis
```

### Problem: "ECONNREFUSED" error

**Solution**: Redis might not be ready when app starts

```bash
# Restart the app container
docker-compose restart app

# Or rebuild with proper wait
docker-compose down
docker-compose up -d
```

### Problem: Redis memory issues

**Check memory**:
```bash
docker exec -it twocents-redis redis-cli INFO memory
```

**Clear data**:
```bash
docker exec -it twocents-redis redis-cli FLUSHALL
```

## 🔄 Development Workflow

### Making Changes

1. **Update code** in `redis/` directory
2. **Rebuild app** container:
   ```bash
   docker-compose up -d --build app
   ```
3. **Check logs**:
   ```bash
   docker-compose logs -f app
   ```

### Quick Restart

```bash
# Restart just the app (keeps data)
docker-compose restart app

# Restart all services
docker-compose restart

# Full rebuild
docker-compose down
docker-compose up -d --build
```

## ✅ Verification Checklist

- [ ] All Docker containers are running (`docker ps`)
- [ ] App logs show "✓ Redis connected and ready"
- [ ] Health endpoint returns OK (`curl http://localhost/health`)
- [ ] Root endpoint returns Redis test data (`curl http://localhost/`)
- [ ] Redis CLI can connect (`docker exec -it twocents-redis redis-cli PING`)
- [ ] Test suite passes (`node redis/test/redis.test.js`)

## 📚 Next Steps

Once Redis is working:

1. **Implement Order Submission**: `POST /orders` endpoint
2. **Add Order Book API**: `GET /orderbook/:instrument`
3. **Add Trades API**: `GET /trades/:instrument`
4. **Implement WebSocket**: Real-time order book updates
5. **Add Metrics**: `/metrics` endpoint

## 🔗 Related Documentation

- `redis/README.md` - Complete Redis API reference
- `redis/STRUCTURE.md` - Architecture details
- `docker-compose.yml` - Service configuration
- `.env` - Environment variables

