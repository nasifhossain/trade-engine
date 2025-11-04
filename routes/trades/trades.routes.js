const express = require('express');
const { DB } = require('../../db/query');

const router = express.Router();

/**
 * Trades Routes
 * Handles retrieval and persistence of trade data
 */

/**
 * GET /trades/recent
 * Retrieve recent trades with optional filtering
 * 
 * Query parameters:
 * - limit: number of trades to return (default: 50, max: 500)
 * - instrument: filter by trading instrument (default: BTC-USD)
 * - offset: pagination offset (default: 0)
 */
router.get('/recent', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 500);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);
        const instrument = req.query.instrument || 'BTC-USD';

        // Try Redis cache first for fast lookups
        const redisService = req.app.locals.redisService;
        const cacheKey = `trades:recent:${instrument}:${limit}:${offset}`;
        
        try {
            const cached = await redisService.redis.get(cacheKey);
            if (cached) {
                console.log(`✓ Cache hit for recent trades: ${cacheKey}`);
                return res.json({
                    source: 'cache',
                    instrument,
                    trades: JSON.parse(cached),
                    cached_at: new Date().toISOString()
                });
            }
        } catch (cacheError) {
            console.warn('Redis cache error (continuing):', cacheError.message);
        }

        // Query from database
        const trades = await DB.find('trades', { instrument }, {
            order_by: 'executed_at DESC',
            limit,
            offset
        });

        // Get total count for pagination
        const countResult = await DB.find('trades', { instrument }, { count: true });
        const total = countResult[0]?.count || 0;

        const response = {
            source: 'database',
            instrument,
            pagination: {
                limit,
                offset,
                total,
                hasMore: (offset + limit) < total
            },
            trades: trades.map(trade => ({
                trade_id: trade.trade_id,
                buy_order_id: trade.buy_order_id,
                sell_order_id: trade.sell_order_id,
                price: parseFloat(trade.price),
                quantity: parseFloat(trade.quantity),
                executed_at: trade.executed_at
            }))
        };

        // Cache result for 30 seconds
        try {
            await redisService.redis.setEx(
                cacheKey,
                30,
                JSON.stringify(response.trades)
            );
        } catch (cacheError) {
            console.warn('Failed to cache trades:', cacheError.message);
        }

        res.json(response);
    } catch (error) {
        console.error('Error fetching recent trades:', error);
        res.status(500).json({
            error: 'Failed to fetch trades',
            details: error.message
        });
    }
});

/**
 * POST /trades/snapshot
 * Create and persist a snapshot of current trades
 * 
 * Body:
 * {
 *   "instrument": "BTC-USD",
 *   "limit": 100
 * }
 */
router.post('/snapshot', async (req, res) => {
    try {
        const { instrument = 'BTC-USD', limit = 100 } = req.body;

        // Fetch recent trades
        const trades = await DB.find('trades', { instrument }, {
            order_by: 'executed_at DESC',
            limit
        });

        if (trades.length === 0) {
            return res.status(400).json({
                error: 'No trades found for this instrument'
            });
        }

        // Calculate aggregate statistics
        let totalVolume = 0;
        let totalValue = 0;
        let highPrice = 0;
        let lowPrice = Infinity;

        trades.forEach(trade => {
            const price = parseFloat(trade.price);
            const quantity = parseFloat(trade.quantity);
            totalVolume += quantity;
            totalValue += price * quantity;
            highPrice = Math.max(highPrice, price);
            lowPrice = Math.min(lowPrice, price);
        });

        const vwap = totalVolume > 0 ? totalValue / totalVolume : 0;

        const snapshotData = {
            trades: trades.map(t => ({
                trade_id: t.trade_id,
                price: parseFloat(t.price),
                quantity: parseFloat(t.quantity),
                executed_at: t.executed_at
            })),
            statistics: {
                count: trades.length,
                volume: parseFloat(totalVolume.toFixed(8)),
                value: parseFloat(totalValue.toFixed(8)),
                vwap: parseFloat(vwap.toFixed(8)),
                high: parseFloat(highPrice.toFixed(8)),
                low: parseFloat(lowPrice.toFixed(8))
            }
        };

        // Persist snapshot to database
        const { randomUUID } = require('crypto');
        await DB.insert('orderbook_snapshots', {
            snapshot_id: randomUUID(),
            instrument,
            snapshot_type: 'trades',
            snapshot_data: JSON.stringify(snapshotData),
            created_at: new Date()
        });

        res.status(201).json({
            success: true,
            message: 'Trade snapshot created',
            instrument,
            snapshot: snapshotData,
            snapshot_created_at: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error creating trade snapshot:', error);
        res.status(500).json({
            error: 'Failed to create trade snapshot',
            details: error.message
        });
    }
});

/**
 * GET /trades/stats
 * Get trade statistics for a given instrument
 */
router.get('/stats', async (req, res) => {
    try {
        const { instrument = 'BTC-USD', window = '1h' } = req.query;

        // Calculate time window
        let windowMs = 3600000; // 1 hour default
        if (window === '5m') windowMs = 300000;
        else if (window === '15m') windowMs = 900000;
        else if (window === '1h') windowMs = 3600000;
        else if (window === '24h') windowMs = 86400000;

        const startTime = new Date(Date.now() - windowMs);

        // Query trades within window
        const trades = await DB.find('trades', {
            instrument,
            executed_at: { $gte: startTime }
        });

        if (trades.length === 0) {
            return res.json({
                instrument,
                window,
                stats: {
                    trades: 0,
                    volume: 0,
                    vwap: 0,
                    high: null,
                    low: null
                }
            });
        }

        // Calculate statistics
        let totalVolume = 0;
        let totalValue = 0;
        let highPrice = 0;
        let lowPrice = Infinity;

        trades.forEach(trade => {
            const price = parseFloat(trade.price);
            const quantity = parseFloat(trade.quantity);
            totalVolume += quantity;
            totalValue += price * quantity;
            highPrice = Math.max(highPrice, price);
            lowPrice = Math.min(lowPrice, price);
        });

        const vwap = totalVolume > 0 ? totalValue / totalVolume : 0;

        res.json({
            instrument,
            window,
            stats: {
                trades: trades.length,
                volume: parseFloat(totalVolume.toFixed(8)),
                vwap: parseFloat(vwap.toFixed(8)),
                high: parseFloat(highPrice.toFixed(8)),
                low: parseFloat(lowPrice.toFixed(8)),
                period_start: startTime.toISOString(),
                period_end: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error('Error fetching trade statistics:', error);
        res.status(500).json({
            error: 'Failed to fetch trade statistics',
            details: error.message
        });
    }
});

module.exports = router;
