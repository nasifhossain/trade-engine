# Database Schema Documentation

## Trading Engine Database Architecture

This document describes the MySQL database schema for the Real-Time Trade Clearing & Analytics Engine.

---

## Table Relationships (ER Diagram)

```
┌──────────────────────────────────────────────────────────────────┐
│                        MYSQL TABLES                               │
└──────────────────────────────────────────────────────────────────┘

┌─────────────────────────┐
│       orders            │  ◄─── Primary entity: All orders
├─────────────────────────┤
│ PK order_id (VARCHAR)   │
│    client_id            │
│    instrument           │
│    side (ENUM)          │
│    type (ENUM)          │
│    price (DECIMAL)      │
│    quantity             │
│    filled_quantity      │
│    status (ENUM)        │
│    created_at(6)        │  ← Microsecond precision for price-time
│    updated_at(6)        │
└─────────────────────────┘
         │ 1
         │
         │ *
         ▼
┌─────────────────────────┐
│       trades            │  ◄─── Execution history
├─────────────────────────┤
│ PK trade_id             │
│ FK buy_order_id     ────┼──► orders.order_id
│ FK sell_order_id    ────┼──► orders.order_id
│    instrument           │
│    price                │
│    quantity             │
│    buy_client_id        │
│    sell_client_id       │
│    executed_at(6)       │
└─────────────────────────┘


┌─────────────────────────┐
│  idempotency_keys       │  ◄─── Prevent duplicate submissions
├─────────────────────────┤
│ PK idempotency_key      │
│ FK order_id         ────┼──► orders.order_id
│    response_data (JSON) │
│    http_status          │
│    created_at           │
│    expires_at           │
└─────────────────────────┘


┌─────────────────────────┐
│ order_book_snapshots    │  ◄─── Recovery & performance
├─────────────────────────┤
│ PK snapshot_id          │
│    instrument           │
│    snapshot_data (JSON) │
│    order_count          │
│    snapshot_type        │
│    snapshot_at(6)       │
└─────────────────────────┘


┌─────────────────────────┐
│  order_audit_log        │  ◄─── State change tracking (Optional)
├─────────────────────────┤
│ PK log_id               │
│ FK order_id         ────┼──► orders.order_id
│    old_status           │
│    new_status           │
│    old_filled_quantity  │
│    new_filled_quantity  │
│    reason               │
│    trade_id             │
│    logged_at(6)         │
└─────────────────────────┘
```

---

## Table Descriptions

### 1. **orders** (Core Table)
**Purpose:** Stores all orders submitted to the trading engine

| Column | Type | Description |
|--------|------|-------------|
| order_id | VARCHAR(36) | UUID, Primary Key |
| client_id | VARCHAR(50) | Client identifier |
| instrument | VARCHAR(20) | Trading pair (e.g., BTC-USD) |
| side | ENUM('buy','sell') | Order side |
| type | ENUM('market','limit') | Order type |
| price | DECIMAL(20,8) | Price (NULL for market orders) |
| quantity | DECIMAL(20,8) | Order quantity |
| filled_quantity | DECIMAL(20,8) | Amount filled so far |
| status | ENUM | open, partially_filled, filled, cancelled, rejected |
| created_at | TIMESTAMP(6) | **Microsecond precision** for price-time priority |
| updated_at | TIMESTAMP(6) | Last modification time |

**Indexes:**
- PRIMARY KEY: `order_id`
- INDEX: `client_id` (client queries)
- INDEX: `(instrument, status)` (open orders by instrument)
- INDEX: `(instrument, status, side)` (order book rebuilding)
- INDEX: `created_at` (price-time priority)

**Lifecycle:**
```
open → partially_filled → filled
  ↓            ↓
cancelled  cancelled
```

---

### 2. **trades** (Execution Records)
**Purpose:** Stores every matched trade (immutable audit trail)

| Column | Type | Description |
|--------|------|-------------|
| trade_id | VARCHAR(36) | UUID, Primary Key |
| buy_order_id | VARCHAR(36) | FK → orders.order_id |
| sell_order_id | VARCHAR(36) | FK → orders.order_id |
| instrument | VARCHAR(20) | Trading pair |
| price | DECIMAL(20,8) | Execution price |
| quantity | DECIMAL(20,8) | Matched quantity |
| buy_client_id | VARCHAR(50) | Buyer identifier |
| sell_client_id | VARCHAR(50) | Seller identifier |
| executed_at | TIMESTAMP(6) | Match timestamp |

**Indexes:**
- PRIMARY KEY: `trade_id`
- INDEX: `buy_order_id`, `sell_order_id`
- INDEX: `(buy_order_id, sell_order_id)` composite
- INDEX: `instrument`, `(instrument, executed_at)`
- INDEX: `executed_at`
- INDEX: `buy_client_id`, `sell_client_id`

**Foreign Keys:**
- `buy_order_id` → `orders(order_id)` ON DELETE RESTRICT
- `sell_order_id` → `orders(order_id)` ON DELETE RESTRICT

---

### 3. **idempotency_keys** (Duplicate Prevention)
**Purpose:** Prevent duplicate order submissions (assignment requirement)

| Column | Type | Description |
|--------|------|-------------|
| idempotency_key | VARCHAR(255) | Client-provided key, PK |
| order_id | VARCHAR(36) | FK → orders.order_id |
| response_data | JSON | Cached API response |
| http_status | INT(3) | HTTP status (200, 400, etc.) |
| created_at | TIMESTAMP | First seen |
| expires_at | TIMESTAMP | Optional expiration (cleanup) |

**Usage:**
```javascript
// Client submits same idempotency_key twice
POST /orders
{
  "idempotency_key": "abc-123",
  "client_id": "client-A",
  // ... other fields
}

// Second request returns cached response
// Order is NOT created twice
// Matching engine does NOT see duplicate
```

**Indexes:**
- PRIMARY KEY: `idempotency_key`
- INDEX: `order_id`
- INDEX: `expires_at` (cleanup job)

**Foreign Keys:**
- `order_id` → `orders(order_id)` ON DELETE CASCADE

---

### 4. **order_book_snapshots** (Recovery)
**Purpose:** Periodic snapshots of order book state for fast recovery

| Column | Type | Description |
|--------|------|-------------|
| snapshot_id | BIGINT | Auto-increment PK |
| instrument | VARCHAR(20) | Trading pair |
| snapshot_data | JSON | Serialized order book |
| order_count | INT | Number of orders in snapshot |
| snapshot_type | ENUM | scheduled, manual, shutdown |
| snapshot_at | TIMESTAMP(6) | Snapshot creation time |

**Recovery Strategy:**
1. Load latest snapshot for instrument
2. Replay all orders created after `snapshot_at`
3. Rebuild in-memory order book

**Snapshot Data Format (JSON):**
```json
{
  "instrument": "BTC-USD",
  "bids": [
    {"order_id": "uuid1", "price": "70200.50", "quantity": "0.5", ...},
    {"order_id": "uuid2", "price": "70195.00", "quantity": "1.0", ...}
  ],
  "asks": [
    {"order_id": "uuid3", "price": "70205.00", "quantity": "0.3", ...}
  ],
  "snapshot_at": "2025-11-02T12:34:56.123456Z"
}
```

**Indexes:**
- PRIMARY KEY: `snapshot_id`
- INDEX: `instrument`, `(instrument, snapshot_at)`
- INDEX: `snapshot_at`

---

### 5. **order_audit_log** (Optional State Tracking)
**Purpose:** Track every state change for debugging and compliance

| Column | Type | Description |
|--------|------|-------------|
| log_id | BIGINT | Auto-increment PK |
| order_id | VARCHAR(36) | FK → orders.order_id |
| old_status | VARCHAR(20) | Previous status (NULL if new) |
| new_status | VARCHAR(20) | New status |
| old_filled_quantity | DECIMAL(20,8) | Previous filled amount |
| new_filled_quantity | DECIMAL(20,8) | New filled amount |
| reason | VARCHAR(255) | Change reason |
| trade_id | VARCHAR(36) | Related trade (if match event) |
| logged_at | TIMESTAMP(6) | Log entry timestamp |

**Example Log Entries:**
```
order_id: uuid-123
old_status: open, new_status: partially_filled
old_filled_qty: 0, new_filled_qty: 0.25
reason: matched_with_trade_xyz
logged_at: 2025-11-02T12:34:56.789012
```

**Indexes:**
- PRIMARY KEY: `log_id`
- INDEX: `order_id`, `(order_id, logged_at)`
- INDEX: `trade_id`, `logged_at`, `new_status`

**Foreign Keys:**
- `order_id` → `orders(order_id)` ON DELETE CASCADE

---

## Performance Considerations

### Timestamp Precision
All timestamp fields use **TIMESTAMP(6)** for microsecond precision:
- Critical for **price-time priority** matching
- Two orders at same price → earlier timestamp wins
- Microseconds prevent collisions on high-frequency submissions

### Decimal Precision
All financial fields use **DECIMAL(20,8)**:
- 20 total digits, 8 after decimal point
- Never use FLOAT/DOUBLE for money (rounding errors)
- Supports prices like: 12345678.12345678

### Indexes Strategy
- **Composite indexes** for common query patterns
- **instrument + status** → "Show me all open BTC-USD orders"
- **created_at** → Price-time priority sorting
- **Foreign keys** with proper ON DELETE/UPDATE actions

---

## Migration Files

| File | Table | Purpose |
|------|-------|---------|
| `001_create_users_table.js` | users | User authentication (optional) |
| `002_create_orders_table.js` | orders | Core order storage |
| `003_create_trades_table.js` | trades | Execution records with FKs |
| `004_create_idempotency_keys_table.js` | idempotency_keys | Duplicate prevention |
| `005_create_order_book_snapshots_table.js` | order_book_snapshots | Recovery strategy |
| `006_create_order_audit_log_table.js` | order_audit_log | State change tracking (optional) |

---

## Running Migrations

```bash
# Run all pending migrations
node db/migrate.js up

# Rollback last migration
node db/migrate.js down

# Rollback all migrations
node db/migrate.js down --all

# Check migration status
node db/migrate.js status
```

---

## Data Flow Example

### Order Submission → Matching → Trade Creation

```
1. Client submits order
   POST /orders { idempotency_key, ... }
   
2. Check idempotency_keys table
   - If exists: return cached response
   - If new: proceed
   
3. Insert into orders table
   status = 'open'
   filled_quantity = 0
   
4. Add to Redis order book (ZSET)
   
5. Matching engine runs
   - Match orders
   - Update orders.filled_quantity
   - Update orders.status
   
6. Insert into trades table
   buy_order_id, sell_order_id, price, quantity
   
7. Insert into order_audit_log
   old_status → new_status
   
8. Cache in Redis
   trades:recent:BTC-USD
   
9. Broadcast via WebSocket
   orderbook_delta, trade_event
```

---

## Foreign Key Relationships Summary

```
trades.buy_order_id  ──FK──► orders.order_id (RESTRICT)
trades.sell_order_id ──FK──► orders.order_id (RESTRICT)

idempotency_keys.order_id ──FK──► orders.order_id (CASCADE)

order_audit_log.order_id  ──FK──► orders.order_id (CASCADE)
```

**RESTRICT:** Cannot delete order if trades reference it
**CASCADE:** Deleting order also deletes idempotency keys and audit logs

---

## Next Steps

1. Run migrations to create all tables
2. Implement matching engine to populate tables
3. Build APIs to query tables
4. Add monitoring for table sizes and query performance
5. Set up backup/restore procedures

---

Generated: 2025-11-02
Version: 1.0

