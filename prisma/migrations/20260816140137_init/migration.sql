-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('buy', 'sell');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('market', 'limit');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('open', 'partially_filled', 'filled', 'cancelled', 'rejected');

-- CreateEnum
CREATE TYPE "SnapshotType" AS ENUM ('scheduled', 'manual', 'shutdown');

-- CreateTable
CREATE TABLE "orders" (
    "order_id" VARCHAR(36) NOT NULL,
    "client_id" VARCHAR(50) NOT NULL,
    "instrument" VARCHAR(20) NOT NULL,
    "side" "OrderSide" NOT NULL,
    "type" "OrderType" NOT NULL,
    "price" DECIMAL(20,8),
    "quantity" DECIMAL(20,8) NOT NULL,
    "filled_quantity" DECIMAL(20,8) NOT NULL DEFAULT 0.0,
    "status" "OrderStatus" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "trades" (
    "trade_id" VARCHAR(36) NOT NULL,
    "buy_order_id" VARCHAR(36) NOT NULL,
    "sell_order_id" VARCHAR(36) NOT NULL,
    "instrument" VARCHAR(20) NOT NULL,
    "price" DECIMAL(20,8) NOT NULL,
    "quantity" DECIMAL(20,8) NOT NULL,
    "buy_client_id" VARCHAR(50) NOT NULL,
    "sell_client_id" VARCHAR(50) NOT NULL,
    "executed_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("trade_id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "idempotency_key" VARCHAR(255) NOT NULL,
    "order_id" VARCHAR(36) NOT NULL,
    "response_data" JSONB,
    "http_status" INTEGER NOT NULL DEFAULT 200,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(6),

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("idempotency_key")
);

-- CreateTable
CREATE TABLE "order_book_snapshots" (
    "snapshot_id" BIGSERIAL NOT NULL,
    "instrument" VARCHAR(20) NOT NULL,
    "snapshot_data" JSONB NOT NULL,
    "order_count" INTEGER NOT NULL DEFAULT 0,
    "snapshot_type" "SnapshotType" NOT NULL DEFAULT 'scheduled',
    "snapshot_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_book_snapshots_pkey" PRIMARY KEY ("snapshot_id")
);

-- CreateIndex
CREATE INDEX "orders_client_id_idx" ON "orders"("client_id");

-- CreateIndex
CREATE INDEX "orders_instrument_idx" ON "orders"("instrument");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_created_at_idx" ON "orders"("created_at");

-- CreateIndex
CREATE INDEX "trades_buy_order_id_idx" ON "trades"("buy_order_id");

-- CreateIndex
CREATE INDEX "trades_sell_order_id_idx" ON "trades"("sell_order_id");

-- CreateIndex
CREATE INDEX "trades_instrument_idx" ON "trades"("instrument");

-- CreateIndex
CREATE INDEX "trades_executed_at_idx" ON "trades"("executed_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_order_id_idx" ON "idempotency_keys"("order_id");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE INDEX "order_book_snapshots_instrument_idx" ON "order_book_snapshots"("instrument");

-- CreateIndex
CREATE INDEX "order_book_snapshots_snapshot_at_idx" ON "order_book_snapshots"("snapshot_at");

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_buy_order_id_fkey" FOREIGN KEY ("buy_order_id") REFERENCES "orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_sell_order_id_fkey" FOREIGN KEY ("sell_order_id") REFERENCES "orders"("order_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE CASCADE ON UPDATE CASCADE;
