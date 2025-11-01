# Database Migrations

## Overview

This directory contains all database migrations for the Trading Engine.

Each migration file has:
- `up()` function - creates tables/indexes/constraints
- `down()` function - reverses the changes (drops tables/constraints)

---

## Migration Files (In Order)

### ✅ 001_create_users_table.js
**Status:** Existing  
**Table:** `users`  
**Purpose:** User authentication and management (optional for trading engine)

---

### ✅ 002_create_orders_table.js
**Status:** Updated for trading engine  
**Table:** `orders`  
**Purpose:** Core order storage with microsecond precision timestamps

**Key Changes:**
- Primary key: `order_id` (UUID)
- Status: `open`, `partially_filled`, `filled`, `cancelled`, `rejected`
- Type: `market`, `limit` only (removed stop orders)
- Price: `NULL` for market orders
- Microsecond timestamps for price-time priority
- Optimized composite indexes

**Indexes:**
```sql
PK: order_id
INDEX: client_id
INDEX: (instrument, status)
INDEX: (instrument, status, side)
INDEX: created_at
```

---

### ✅ 003_create_trades_table.js
**Status:** New  
**Table:** `trades`  
**Purpose:** Immutable record of all matched executions

**Relationships:**
- Foreign Key: `buy_order_id` → `orders.order_id` (RESTRICT)
- Foreign Key: `sell_order_id` → `orders.order_id` (RESTRICT)

**Key Features:**
- Stores both client_ids (buyer and seller)
- Microsecond execution timestamps
- Cannot delete orders that have trades (RESTRICT)

**Indexes:**
```sql
PK: trade_id
INDEX: buy_order_id
INDEX: sell_order_id
INDEX: (buy_order_id, sell_order_id)
INDEX: instrument
INDEX: (instrument, executed_at)
INDEX: executed_at
INDEX: buy_client_id, sell_client_id
```

---

### ✅ 004_create_idempotency_keys_table.js
**Status:** New  
**Table:** `idempotency_keys`  
**Purpose:** Prevent duplicate order submissions (assignment requirement)

**Relationships:**
- Foreign Key: `order_id` → `orders.order_id` (CASCADE)

**Key Features:**
- Caches original API response as JSON
- Stores HTTP status code
- Optional expiration for cleanup
- Deletes automatically when order is deleted (CASCADE)

**Indexes:**
```sql
PK: idempotency_key
INDEX: order_id
INDEX: expires_at
```

---

### ✅ 005_create_order_book_snapshots_table.js
**Status:** New  
**Table:** `order_book_snapshots`  
**Purpose:** Periodic snapshots for fast recovery

**Key Features:**
- Stores entire order book as JSON
- Tracks order count for monitoring
- Snapshot type: scheduled, manual, shutdown
- Used for recovery after restart

**Recovery Strategy:**
1. Load latest snapshot
2. Replay orders created after `snapshot_at`
3. Rebuild in-memory order book

**Indexes:**
```sql
PK: snapshot_id
INDEX: instrument
INDEX: (instrument, snapshot_at)
INDEX: snapshot_at
```

---

### ✅ 006_create_order_audit_log_table.js
**Status:** New (Optional but Recommended)  
**Table:** `order_audit_log`  
**Purpose:** Track every state change for debugging and compliance

**Relationships:**
- Foreign Key: `order_id` → `orders.order_id` (CASCADE)

**Key Features:**
- Logs every status change
- Tracks filled_quantity changes
- Records reason for change
- Links to trade_id if match event
- Automatically deleted when order deleted (CASCADE)

**Indexes:**
```sql
PK: log_id
INDEX: order_id
INDEX: (order_id, logged_at)
INDEX: trade_id
INDEX: logged_at
INDEX: new_status
```

---

## Foreign Key Relationships Diagram

```
┌─────────────┐
│   orders    │ ◄──────────────┐
└──────┬──────┘                │
       │                       │
       │ FK (RESTRICT)         │ FK (CASCADE)
       ▼                       │
┌─────────────┐         ┌──────────────────┐
│   trades    │         │ idempotency_keys │
└─────────────┘         └──────────────────┘

       │
       │ FK (CASCADE)
       ▼
┌──────────────────┐
│ order_audit_log  │
└──────────────────┘

(order_book_snapshots has NO foreign keys)
```

**RESTRICT:** Cannot delete if referenced (protects trade history)  
**CASCADE:** Deletes automatically (cleanup)

---

## Running Migrations

### Prerequisites
Make sure you have:
1. MySQL connection configured in `.env`
2. Database created: `twocents_db`
3. DBForge utility loaded (`db/index.js`)

### Commands

```bash
# Run all pending migrations
node db/migrate.js up

# Run specific migration
node db/migrate.js up --file 003_create_trades_table.js

# Rollback last migration
node db/migrate.js down

# Rollback specific migration
node db/migrate.js down --file 003_create_trades_table.js

# Check status
node db/migrate.js status
```

### Via Docker

```bash
# Run migrations in Docker container
docker-compose exec app node db/migrate.js up

# Or during container startup (add to package.json)
"scripts": {
  "migrate": "node db/migrate.js up",
  "migrate:down": "node db/migrate.js down"
}
```

---

## Testing Migrations

### Test Up Migration
```bash
# Run migration
node db/migrate.js up --file 002_create_orders_table.js

# Verify table created
docker exec -it twocents-mysql mysql -u root -prootpassword twocents_db -e "DESCRIBE orders;"
```

### Test Down Migration
```bash
# Rollback
node db/migrate.js down --file 002_create_orders_table.js

# Verify table dropped
docker exec -it twocents-mysql mysql -u root -prootpassword twocents_db -e "SHOW TABLES;"
```

---

## Migration Best Practices

### ✅ DO
- Run migrations in order (001, 002, 003, ...)
- Test both `up()` and `down()` functions
- Backup database before running migrations
- Use transactions where possible
- Add comments explaining complex logic

### ❌ DON'T
- Modify existing migration files after deployment
- Delete migration files
- Run migrations manually with SQL (use migration tool)
- Skip migration files
- Remove foreign key constraints without plan

---

## Troubleshooting

### Error: "Cannot add foreign key constraint"
**Cause:** Parent table doesn't exist or column types don't match

**Fix:**
```bash
# Check if parent table exists
SHOW TABLES;

# Check column types match
DESCRIBE orders;
DESCRIBE trades;

# Ensure migrations run in order
```

### Error: "Table already exists"
**Cause:** Migration already ran

**Fix:**
```bash
# Check migration status
node db/migrate.js status

# Or skip with:
node db/migrate.js up --skip-existing
```

### Error: "Cannot drop table with foreign key"
**Cause:** Down migration needs to drop FKs first

**Fix:** Already handled in migration files:
```javascript
async function down(pool) {
  // Drop foreign keys FIRST
  await pool.query('ALTER TABLE trades DROP FOREIGN KEY fk_trades_buy_order');
  
  // Then drop table
  await forge.drop_table('trades');
}
```

---

## Database Schema Version

Current schema version: **v1.0**

| Version | Date | Changes |
|---------|------|---------|
| v1.0 | 2025-11-02 | Initial schema with 6 tables |

---

## Next Steps

1. ✅ Run all migrations: `node db/migrate.js up`
2. ⬜ Verify tables created in MySQL
3. ⬜ Test foreign key constraints
4. ⬜ Load sample data for testing
5. ⬜ Build matching engine to use these tables
6. ⬜ Implement recovery strategy using snapshots

---

Generated: 2025-11-02  
Author: Trading Engine Team  

