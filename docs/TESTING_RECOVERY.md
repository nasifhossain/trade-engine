# Testing Recovery & Snapshot System

## Quick Test Guide

### Test 1: Create Orders and Verify Snapshot

```bash
# 1. Create some test orders
curl -X POST http://localhost/api/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-order-1" \
  -d '{
    "client_id": "client-A",
    "instrument": "BTC-USD",
    "side": "sell",
    "type": "limit",
    "price": 70000,
    "quantity": 0.5
  }'

curl -X POST http://localhost/api/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key": test-order-2" \
  -d '{
    "client_id": "client-B",
    "instrument": "BTC-USD",
    "side": "buy",
    "type": "limit",
    "price": 69000,
    "quantity": 0.3
  }'

# 2. Wait for snapshot (or trigger manually - see below)
# Default interval: 5 minutes
# First snapshot starts 30 seconds after startup

# 3. Check snapshot was created
docker-compose exec mysql mysql -u twocents_user -ptwocents_pass twocents_db \
  -e "SELECT instrument, order_count, snapshot_type, snapshot_at FROM order_book_snapshots ORDER BY snapshot_at DESC LIMIT 5;"
```

### Test 2: Manual Snapshot Trigger

```bash
# Connect to MySQL
docker-compose exec mysql mysql -u twocents_user -ptwocents_pass twocents_db

# Check current snapshots
SELECT instrument, order_count, snapshot_type, snapshot_at 
FROM order_book_snapshots 
ORDER BY snapshot_at DESC 
LIMIT 5;

# Note: Manual triggering requires code addition or wait for periodic snapshot
```

### Test 3: Recovery from Snapshot

```bash
# 1. Create multiple orders (at least 10)
for i in {1..10}; do
  curl -X POST http://localhost/api/orders \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: batch-order-$i" \
    -d "{
      \"client_id\": \"client-$i\",
      \"instrument\": \"BTC-USD\",
      \"side\": \"sell\",
      \"type\": \"limit\",
      \"price\": $((70000 + i * 10)),
      \"quantity\": 0.1
    }"
done

# 2. Wait 30 seconds for initial snapshot (or 5 min for next periodic one)
sleep 35

# 3. Add a few more orders AFTER snapshot
curl -X POST http://localhost/api/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: post-snapshot-1" \
  -d '{
    "client_id": "client-Z",
    "instrument": "BTC-USD",
    "side": "sell",
    "type": "limit",
    "price": 71000,
    "quantity": 0.2
  }'

# 4. Restart app (this triggers recovery)
docker-compose restart app

# 5. Check logs for recovery stats
docker-compose logs app | grep -A 10 "snapshot_replay\|full_replay"

# You should see:
# - "Using snapshot-based recovery..."
# - "recovered in Xms: Y from snapshot + Z replayed"
# - Recovery time should be ~2-5 seconds
```

### Test 4: Full Replay (Disable Snapshots)

```bash
# 1. Stop the app
docker-compose stop app

# 2. Update docker-compose.yml to disable snapshots
# Add environment variable:
# SNAPSHOTS_ENABLED=false

# OR create .env file:
echo "SNAPSHOTS_ENABLED=false" > .env

# 3. Start app
docker-compose up -d app

# 4. Check logs for full replay
docker-compose logs app | grep "full replay"

# You should see:
# - "Using full replay recovery (no snapshots)..."
# - Time will be slower (5-30s depending on order count)
```

### Test 5: Graceful Shutdown Snapshot

```bash
# 1. Create orders
# (use commands from Test 1)

# 2. Gracefully stop the app
docker-compose stop app

# 3. Check logs for shutdown snapshot
docker-compose logs app | grep -A 5 "shutdown"

# You should see:
# - "SIGTERM received, shutting down gracefully..."
# - "Creating shutdown snapshots..."
# - "Shutdown snapshot for BTC-USD: X orders"

# 4. Verify shutdown snapshot in DB
docker-compose exec mysql mysql -u twocents_user -ptwocents_pass twocents_db \
  -e "SELECT instrument, order_count, snapshot_type, snapshot_at FROM order_book_snapshots WHERE snapshot_type='shutdown' ORDER BY snapshot_at DESC LIMIT 3;"
```

### Test 6: Recovery Performance Benchmark

```bash
# 1. Create many orders (simulate high volume)
for i in {1..100}; do
  curl -X POST http://localhost/api/orders \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: bench-order-$i" \
    -d "{
      \"client_id\": \"bench-client-$((i % 10))\",
      \"instrument\": \"BTC-USD\",
      \"side\": \"$([[ $((i % 2)) -eq 0 ]] && echo 'buy' || echo 'sell')\",
      \"type\": \"limit\",
      \"price\": $((69000 + RANDOM % 2000)),
      \"quantity\": 0.1
    }"
done

# 2. Wait for snapshot
sleep 35

# 3. Restart and time recovery
time docker-compose restart app

# 4. Check detailed recovery stats in logs
docker-compose logs app | grep -E "recovered|Recovery|snapshot"
```

### Test 7: Verify Snapshot Cleanup

```bash
# 1. Create 15 snapshots (more than retention limit of 10)
# This would take 75 minutes with 5-min intervals
# For testing, reduce interval temporarily

# 2. Check snapshot count
docker-compose exec mysql mysql -u twocents_user -ptwocents_pass twocents_db \
  -e "SELECT instrument, COUNT(*) as snapshot_count FROM order_book_snapshots GROUP BY instrument;"

# Should show max 10 snapshots per instrument
```

### Test 8: Snapshot Data Integrity

```bash
# 1. Create orders with known data
curl -X POST http://localhost/api/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: integrity-test-1" \
  -d '{
    "client_id": "test-client",
    "instrument": "BTC-USD",
    "side": "sell",
    "type": "limit",
    "price": 70123.45,
    "quantity": 0.555
  }'

# 2. Wait for snapshot
sleep 35

# 3. Query snapshot data
docker-compose exec mysql mysql -u twocents_user -ptwocents_pass twocents_db \
  -e "SELECT instrument, snapshot_data FROM order_book_snapshots WHERE instrument='BTC-USD' ORDER BY snapshot_at DESC LIMIT 1\G"

# 4. Verify JSON contains your order with correct price/quantity
```

## Expected Results

### Snapshot Creation Logs
```
📸 Snapshot created for BTC-USD: 45 orders in 123ms
🗑️  Cleaned up 1 old snapshots for BTC-USD
```

### Recovery Logs (Snapshot)
```
🔄 Initializing matching engine with Redis...
📸 Using snapshot-based recovery...
📸 Loading snapshot for BTC-USD from 2025-11-04T10:35:00.000Z
   → Snapshot: 40 bids, 38 asks
   → Replaying: 5 orders created after snapshot
✅ BTC-USD recovered in 3045ms: 78 from snapshot + 5 replayed
   → Snapshot age: 127s
```

### Recovery Logs (Full Replay)
```
🔄 Initializing matching engine with Redis...
📋 Using full replay recovery (no snapshots)...
📋 Loading 83 open orders into Redis order book
✅ Matching engine initialized successfully via full replay
```

## Configuration Options

### Environment Variables

```bash
# Enable/disable snapshots
SNAPSHOTS_ENABLED=true

# Snapshot interval (milliseconds)
SNAPSHOT_INTERVAL=300000  # 5 minutes
SNAPSHOT_INTERVAL=120000  # 2 minutes (for high-frequency)

# Number of snapshots to retain
SNAPSHOT_RETENTION=10

# Instruments to snapshot (comma-separated)
SNAPSHOT_INSTRUMENTS=BTC-USD,ETH-USD,SOL-USD
```

### Modify in docker-compose.yml

```yaml
services:
  app:
    environment:
      - SNAPSHOTS_ENABLED=true
      - SNAPSHOT_INTERVAL=300000
      - SNAPSHOT_RETENTION=10
      - SNAPSHOT_INSTRUMENTS=BTC-USD,ETH-USD,SOL-USD
```

## Troubleshooting

### Snapshots Not Created

**Check:**
1. `SNAPSHOTS_ENABLED=true` in environment
2. Wait at least 30 seconds after startup (initial delay)
3. Check for orders in orderbook (snapshots skip empty books)
4. Check logs for errors: `docker-compose logs app | grep -i error`

### Recovery Always Uses Full Replay

**Check:**
1. Snapshots exist: `SELECT COUNT(*) FROM order_book_snapshots;`
2. Snapshot service enabled
3. Check logs for "No snapshot found" message
4. Verify snapshot data is valid JSON

### Recovery is Slow

**Expected times:**
- Full replay with 100 orders: ~0.5-1s ✅
- Full replay with 10K orders: ~5s ⚠️
- Snapshot with 10K orders: ~1.5s ✅
- Snapshot with 100K orders: ~4s ✅

**If slower:**
1. Check network latency to Redis/MySQL
2. Check system resources (CPU, memory)
3. Consider reducing snapshot interval
4. Check for other DB load

## Success Criteria

✅ **Snapshot creation works** - Logs show snapshots being created  
✅ **Recovery uses snapshots** - Logs show "snapshot_replay" method  
✅ **Recovery time <5s** - Even with 60K+ orders  
✅ **Graceful shutdown creates snapshot** - Shutdown snapshot in DB  
✅ **Cleanup works** - Max 10 snapshots per instrument  
✅ **Data integrity** - Orders restored correctly after recovery  

## Next Steps

After verifying recovery works:
1. Load test with realistic order volumes
2. Test recovery under different failure scenarios
3. Monitor snapshot size and adjust retention
4. Consider reducing interval for high-frequency systems (2min)

