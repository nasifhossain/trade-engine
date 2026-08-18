// Prisma replaced DB
class SnapshotService {
    constructor(prisma, redisService) {
        this.prisma = prisma;
        this.redisService = redisService;
        
        // Configuration
        this.config = {
            // Snapshot every 5 minutes (reduce to 2 min for high-frequency)
            snapshotInterval: 5 * 60 * 1000,
            
            // Keep last 10 snapshots per instrument
            retentionCount: 10,
            
            // Instruments to snapshot (configure based on your needs)
            instruments: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
            
            // Safety limit to prevent huge snapshots
            maxOrdersPerSnapshot: 100000,
            
            // Enable/disable snapshots
            enabled: true
        };
        
        this.isSnapshotting = false;
        this.intervalHandle = null;
    }

    /**
     * Configure snapshot service
     * @param {Object} config - Configuration options
     */
    configure(config) {
        this.config = { ...this.config, ...config };
        console.log('📸 Snapshot service configured:', this.config);
    }

    /**
     * Start periodic snapshot creation
     */
    startPeriodicSnapshots() {
        if (!this.config.enabled) {
            console.log('⏭️  Snapshot service disabled in config');
            return;
        }

        console.log('📸 Starting periodic snapshot service...');
        console.log(`   → Interval: ${this.config.snapshotInterval / 1000}s`);
        console.log(`   → Retention: ${this.config.retentionCount} snapshots`);
        console.log(`   → Instruments: ${this.config.instruments.join(', ')}`);
        
        // Create initial snapshot on startup (after a delay to let system stabilize)
        setTimeout(async () => {
            try {
                await this.createAllSnapshots();
            } catch (err) {
                console.error('Initial snapshot failed:', err.message);
            }
        }, 30000); // 30 seconds after startup
        
        // Schedule periodic snapshots
        this.intervalHandle = setInterval(async () => {
            try {
                await this.createAllSnapshots();
            } catch (error) {
                console.error('Periodic snapshot failed:', error.message);
            }
        }, this.config.snapshotInterval);
        
        console.log('✅ Snapshot service started');
    }

    /**
     * Stop periodic snapshots
     */
    stopPeriodicSnapshots() {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
            console.log('🛑 Snapshot service stopped');
        }
    }

    /**
     * Create snapshots for all configured instruments
     */
    async createAllSnapshots() {
        if (this.isSnapshotting) {
            console.log('⏭️  Skipping snapshot - already in progress');
            return;
        }

        this.isSnapshotting = true;
        const startTime = Date.now();
        
        try {
            const results = [];
            
            for (const instrument of this.config.instruments) {
                try {
                    const result = await this.createSnapshot(instrument);
                    results.push(result);
                } catch (error) {
                    console.error(`❌ Snapshot failed for ${instrument}:`, error.message);
                    results.push({ instrument, error: error.message, failed: true });
                }
            }
            
            const duration = Date.now() - startTime;
            const successCount = results.filter(r => !r.failed).length;
            const totalOrders = results.reduce((sum, r) => sum + (r.orderCount || 0), 0);
            
            console.log(`📸 Snapshot batch complete: ${successCount}/${results.length} instruments, ${totalOrders} orders in ${duration}ms`);
            
            return results;
        } finally {
            this.isSnapshotting = false;
        }
    }

    /**
     * Create a snapshot for a specific instrument
     * @param {string} instrument - Trading instrument (e.g., 'BTC-USD')
     * @returns {Object} Snapshot result
     */
    async createSnapshot(instrument) {
        const startTime = Date.now();
        
        try {
            // Get orderbook from Redis
            const orderBook = await this.redisService.getOrderBook(
                instrument, 
                this.config.maxOrdersPerSnapshot
            );
            
            const orderCount = orderBook.bids.length + orderBook.asks.length;
            
            if (orderCount === 0) {
                console.log(`⏭️  Skipping snapshot for ${instrument} - empty orderbook`);
                return { instrument, orderCount: 0, skipped: true };
            }
            
            // Get detailed order data for snapshot
            const bidsWithDetails = await this._enrichOrderData(orderBook.bids);
            const asksWithDetails = await this._enrichOrderData(orderBook.asks);
            
            const snapshot_at = new Date();
            const snapshotData = {
                instrument,
                bids: bidsWithDetails,
                asks: asksWithDetails,
                snapshot_at: snapshot_at.toISOString(),
                version: '1.0',
                metadata: {
                    bid_levels: bidsWithDetails.length,
                    ask_levels: asksWithDetails.length,
                    total_orders: orderCount,
                    created_by: 'SnapshotService'
                }
            };
            
            // Insert snapshot into database
            await this.prisma.orderBookSnapshot.create({
                data: {
                    instrument,
                    snapshot_data: snapshotData,
                    order_count: orderCount,
                    snapshot_type: 'scheduled',
                    snapshot_at
                }
            });
            
            const duration = Date.now() - startTime;
            console.log(`✅ Snapshot created for ${instrument}: ${orderCount} orders in ${duration}ms`);
            
            // Cleanup old snapshots (async, don't wait)
            this.cleanupOldSnapshots(instrument).catch(err => 
                console.warn(`Snapshot cleanup failed for ${instrument}:`, err.message)
            );
            
            return { instrument, orderCount, duration, snapshot_at };
            
        } catch (error) {
            console.error(`❌ Error creating snapshot for ${instrument}:`, error);
            throw error;
        }
    }

    /**
     * Enrich orderbook data with full order details from Redis
     * @private
     */
    async _enrichOrderData(orders) {
        const enriched = [];
        
        for (const orderRef of orders) {
            try {
                // Get full order details from Redis cache
                const orderDetails = await this.redisService.getOrderDetails(orderRef.orderId);
                
                if (orderDetails) {
                    enriched.push({
                        order_id: orderDetails.order_id,
                        client_id: orderDetails.client_id,
                        side: orderDetails.side,
                        type: orderDetails.type,
                        price: orderDetails.price,
                        quantity: orderDetails.quantity,
                        filled_quantity: orderDetails.filled_quantity || '0',
                        status: orderDetails.status,
                        created_at: orderDetails.created_at
                    });
                }
            } catch (error) {
                console.warn(`Failed to enrich order ${orderRef.orderId}:`, error.message);
            }
        }
        
        return enriched;
    }

    /**
     * Recover orderbook from latest snapshot + replay
     * @param {string} instrument - Trading instrument
     * @returns {Object} Recovery stats
     */
    async recoverFromSnapshot(instrument) {
        const startTime = Date.now();
        
        try {
            // Find latest snapshot
            const snapshot = await this.prisma.orderBookSnapshot.findFirst({
                where: { instrument },
                orderBy: { snapshot_at: 'desc' }
            });
            
            if (!snapshot) {
                console.log(`⚠️  No snapshot found for ${instrument}, performing full replay`);
                return await this.fullReplayRecovery(instrument);
            }
            
            const snapshotData = typeof snapshot.snapshot_data === 'string' 
                ? JSON.parse(snapshot.snapshot_data) 
                : snapshot.snapshot_data;
            const { bids, asks, snapshot_at } = snapshotData;
            
            console.log(`📸 Loading snapshot for ${instrument} from ${snapshot_at}`);
            console.log(`   → Snapshot: ${bids.length} bids, ${asks.length} asks`);
            
            // Restore bids to Redis
            let restoredCount = 0;
            for (const bid of bids) {
                await this.redisService.addOrderToBook(
                    instrument,
                    'buy',
                    parseFloat(bid.price),
                    bid.order_id,
                    new Date(bid.created_at).getTime()
                );
                
                // Also cache order details
                await this.redisService.storeOrderDetails(bid.order_id, bid);
                restoredCount++;
            }
            
            // Restore asks to Redis
            for (const ask of asks) {
                await this.redisService.addOrderToBook(
                    instrument,
                    'sell',
                    parseFloat(ask.price),
                    ask.order_id,
                    new Date(ask.created_at).getTime()
                );
                
                // Also cache order details
                await this.redisService.storeOrderDetails(ask.order_id, ask);
                restoredCount++;
            }
            
            // Replay orders created AFTER snapshot
            const newOrders = await this.prisma.order.findMany({
                where: {
                    instrument,
                    status: { in: ['open', 'partially_filled'] },
                    created_at: { gt: new Date(snapshot_at) }
                },
                orderBy: { created_at: 'asc' }
            });
            
            console.log(`   → Replaying: ${newOrders.length} orders created after snapshot`);
            
            for (const order of newOrders) {
                if (order.type === 'limit') {
                    await this.redisService.addOrderToBook(
                        order.instrument,
                        order.side,
                        parseFloat(order.price),
                        order.order_id,
                        new Date(order.created_at).getTime()
                    );
                }
                
                await this.redisService.storeOrderDetails(order.order_id, order);
            }
            
            const duration = Date.now() - startTime;
            const snapshotAge = Date.now() - new Date(snapshot_at).getTime();
            
            console.log(`✅ ${instrument} recovered in ${duration}ms: ${restoredCount} from snapshot + ${newOrders.length} replayed`);
            console.log(`   → Snapshot age: ${Math.round(snapshotAge / 1000)}s`);
            
            return {
                instrument,
                method: 'snapshot_replay',
                restoredFromSnapshot: restoredCount,
                replayed: newOrders.length,
                totalOrders: restoredCount + newOrders.length,
                duration,
                snapshot_age: snapshotAge
            };
            
        } catch (error) {
            console.error(`❌ Snapshot recovery failed for ${instrument}:`, error.message);
            console.log(`⚠️  Falling back to full replay for ${instrument}`);
            return await this.fullReplayRecovery(instrument);
        }
    }

    /**
     * Fallback: Full replay from MySQL (no snapshot)
     * @param {string} instrument - Trading instrument
     * @returns {Object} Recovery stats
     */
    async fullReplayRecovery(instrument) {
        const startTime = Date.now();
        
        try {
            // Query all open orders from MySQL
            const orders = await this.prisma.order.findMany({
                where: {
                    instrument,
                    status: { in: ['open', 'partially_filled'] }
                },
                orderBy: { created_at: 'asc' }
            });
            
            console.log(`📋 Full replay for ${instrument}: ${orders.length} orders`);
            
            for (const order of orders) {
                if (order.type === 'limit') {
                    await this.redisService.addOrderToBook(
                        order.instrument,
                        order.side,
                        parseFloat(order.price),
                        order.order_id,
                        new Date(order.created_at).getTime()
                    );
                }
                
                await this.redisService.storeOrderDetails(order.order_id, order);
            }
            
            const duration = Date.now() - startTime;
            console.log(`✅ ${instrument} full replay complete in ${duration}ms`);
            
            return {
                instrument,
                method: 'full_replay',
                totalOrders: orders.length,
                duration
            };
            
        } catch (error) {
            console.error(`❌ Full replay failed for ${instrument}:`, error);
            throw error;
        }
    }

    /**
     * Recover all configured instruments
     * @returns {Object} Recovery stats for all instruments
     */
    async recoverAll() {
        const startTime = Date.now();
        const results = [];
        
        console.log('🔄 Starting recovery for all instruments...');
        
        for (const instrument of this.config.instruments) {
            try {
                const result = await this.recoverFromSnapshot(instrument);
                results.push(result);
            } catch (error) {
                console.error(`Recovery failed for ${instrument}:`, error.message);
                results.push({ 
                    instrument, 
                    error: error.message, 
                    failed: true 
                });
            }
        }
        
        const totalDuration = Date.now() - startTime;
        const successCount = results.filter(r => !r.failed).length;
        const totalOrders = results.reduce((sum, r) => sum + (r.totalOrders || 0), 0);
        
        console.log(`\n✅ Recovery complete: ${successCount}/${results.length} instruments, ${totalOrders} orders in ${totalDuration}ms\n`);
        
        return {
            totalDuration,
            instruments: results,
            successCount,
            totalOrders
        };
    }

    /**
     * Cleanup old snapshots, keep only recent ones
     * @param {string} instrument - Trading instrument
     */
    async cleanupOldSnapshots(instrument) {
        try {
            // Delete old snapshots, keep only the most recent N
            const keepSnapshots = await this.prisma.orderBookSnapshot.findMany({
                where: { instrument },
                orderBy: { snapshot_at: 'desc' },
                take: this.config.retentionCount,
                select: { snapshot_id: true }
            });
            
            const keepIds = keepSnapshots.map(s => s.snapshot_id);
            
            let deleted = { count: 0 };
            if (keepIds.length > 0) {
                deleted = await this.prisma.orderBookSnapshot.deleteMany({
                    where: {
                        instrument,
                        snapshot_id: { notIn: keepIds }
                    }
                });
            }
            
            if (deleted.count > 0) {
                console.log(`🗑️  Cleaned up ${deleted.count} old snapshots for ${instrument}`);
            }
            
            return deleted.count;
        } catch (error) {
            console.warn(`Cleanup failed for ${instrument}:`, error.message);
            return 0;
        }
    }

    /**
     * Create a manual snapshot (for graceful shutdown)
     * @returns {Object} Snapshot results
     */
    async createShutdownSnapshots() {
        console.log('📸 Creating shutdown snapshots...');
        
        const results = [];
        
        for (const instrument of this.config.instruments) {
            try {
                const orderBook = await this.redisService.getOrderBook(instrument, this.config.maxOrdersPerSnapshot);
                const orderCount = orderBook.bids.length + orderBook.asks.length;
                
                if (orderCount === 0) continue;
                
                const bidsWithDetails = await this._enrichOrderData(orderBook.bids);
                const asksWithDetails = await this._enrichOrderData(orderBook.asks);
                
                const snapshot_at = new Date();
                const snapshotData = {
                    instrument,
                    bids: bidsWithDetails,
                    asks: asksWithDetails,
                    snapshot_at: snapshot_at.toISOString(),
                    version: '1.0',
                    metadata: {
                        bid_levels: bidsWithDetails.length,
                        ask_levels: asksWithDetails.length,
                        total_orders: orderCount,
                        created_by: 'graceful_shutdown'
                    }
                };
                
                await this.prisma.orderBookSnapshot.create({
                    data: {
                        instrument,
                        snapshot_data: snapshotData,
                        order_count: orderCount,
                        snapshot_type: 'shutdown',
                        snapshot_at
                    }
                });
                
                console.log(`✅ Shutdown snapshot for ${instrument}: ${orderCount} orders`);
                results.push({ instrument, orderCount });
                
            } catch (error) {
                console.error(`Failed to create shutdown snapshot for ${instrument}:`, error.message);
            }
        }
        
        return results;
    }

    /**
     * Get snapshot statistics
     * @returns {Object} Snapshot stats
     */
    async getSnapshotStats() {
        try {
            const statsRaw = await this.prisma.orderBookSnapshot.groupBy({
                by: ['instrument'],
                _count: { snapshot_id: true },
                _max: { snapshot_at: true },
                _sum: { order_count: true }
            });
            
            return statsRaw.map(s => ({
                instrument: s.instrument,
                snapshot_count: s._count.snapshot_id,
                latest_snapshot: s._max.snapshot_at,
                total_orders_snapshoted: s._sum.order_count || 0
            }));
        } catch (error) {
            console.error('Failed to get snapshot stats:', error);
            return [];
        }
    }
}

module.exports = SnapshotService;

