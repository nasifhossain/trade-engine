const express = require('express');
const { DB } = require('../../db/query');

const router = express.Router();

/**
 * Analytics Routes
 * Advanced analytics endpoints for market data insights
 */

/**
 * GET /analytics/vwap
 * Calculate Volume Weighted Average Price
 * 
 * Query parameters:
 * - instrument: trading instrument (default: BTC-USD)
 * - window: time window in minutes (default: 60)
 */
router.get('/vwap', async (req, res) => {
    try {
        const { instrument = 'BTC-USD', window = '60' } = req.query;
        const windowMinutes = Math.max(parseInt(window), 1);
        const startTime = new Date(Date.now() - windowMinutes * 60000);

        // Fetch trades within window
        const trades = await DB.find('trades', {
            instrument,
            executed_at: { $gte: startTime }
        });

        if (trades.length === 0) {
            return res.json({
                instrument,
                window: `${windowMinutes}m`,
                vwap: null,
                trades_count: 0,
                message: 'No trades in this period'
            });
        }

        // Calculate VWAP
        let totalValue = 0;
        let totalQuantity = 0;

        trades.forEach(trade => {
            const price = parseFloat(trade.price);
            const quantity = parseFloat(trade.quantity);
            totalValue += price * quantity;
            totalQuantity += quantity;
        });

        const vwap = totalQuantity > 0 ? totalValue / totalQuantity : 0;

        res.json({
            instrument,
            window: `${windowMinutes}m`,
            vwap: parseFloat(vwap.toFixed(8)),
            trades_count: trades.length,
            volume: parseFloat(totalQuantity.toFixed(8)),
            notional_value: parseFloat(totalValue.toFixed(8)),
            period_start: startTime.toISOString(),
            period_end: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error calculating VWAP:', error);
        res.status(500).json({
            error: 'Failed to calculate VWAP',
            details: error.message
        });
    }
});

/**
 * GET /analytics/ohlc
 * Get Open-High-Low-Close data
 * 
 * Query parameters:
 * - instrument: trading instrument (default: BTC-USD)
 * - interval: candle interval in minutes (default: 5)
 */
router.get('/ohlc', async (req, res) => {
    try {
        const { instrument = 'BTC-USD', interval = '5' } = req.query;
        const intervalMinutes = Math.max(parseInt(interval), 1);
        const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // Last 24 hours

        // Fetch trades
        const trades = await DB.find('trades', {
            instrument,
            executed_at: { $gte: startTime }
        }, { order_by: 'executed_at ASC' });

        if (trades.length === 0) {
            return res.json({
                instrument,
                interval: `${intervalMinutes}m`,
                candles: [],
                message: 'No trades in this period'
            });
        }

        // Group trades into candles
        const candles = [];
        let currentCandle = null;

        trades.forEach(trade => {
            const price = parseFloat(trade.price);
            const tradeTime = new Date(trade.executed_at);
            const candleTime = Math.floor(tradeTime.getTime() / (intervalMinutes * 60000)) * (intervalMinutes * 60000);

            if (!currentCandle || currentCandle.time !== candleTime) {
                if (currentCandle) {
                    candles.push(currentCandle);
                }
                currentCandle = {
                    time: new Date(candleTime).toISOString(),
                    open: price,
                    high: price,
                    low: price,
                    close: price,
                    volume: 0
                };
            }

            currentCandle.high = Math.max(currentCandle.high, price);
            currentCandle.low = Math.min(currentCandle.low, price);
            currentCandle.close = price;
            currentCandle.volume += parseFloat(trade.quantity);
        });

        if (currentCandle) {
            candles.push(currentCandle);
        }

        // Format response
        const formattedCandles = candles.map(c => ({
            time: c.time,
            open: parseFloat(c.open.toFixed(8)),
            high: parseFloat(c.high.toFixed(8)),
            low: parseFloat(c.low.toFixed(8)),
            close: parseFloat(c.close.toFixed(8)),
            volume: parseFloat(c.volume.toFixed(8))
        }));

        res.json({
            instrument,
            interval: `${intervalMinutes}m`,
            candles: formattedCandles,
            candle_count: formattedCandles.length
        });
    } catch (error) {
        console.error('Error calculating OHLC:', error);
        res.status(500).json({
            error: 'Failed to calculate OHLC',
            details: error.message
        });
    }
});

/**
 * GET /analytics/spread
 * Get bid-ask spread information from order book
 * 
 * Query parameters:
 * - instrument: trading instrument (default: BTC-USD)
 */
router.get('/spread', async (req, res) => {
    try {
        const { instrument = 'BTC-USD' } = req.query;
        const orderServices = req.app.locals.orderServices;

        if (!orderServices) {
            return res.status(503).json({
                error: 'Order services not available'
            });
        }

        // Get current order book
        const orderBook = await orderServices.matchingEngine.getOrderBook(instrument, 20);

        if (orderBook.bids.length === 0 || orderBook.asks.length === 0) {
            return res.json({
                instrument,
                spread: null,
                spread_bps: null,
                message: 'Order book is empty'
            });
        }

        const bestBid = orderBook.bids[0].price;
        const bestAsk = orderBook.asks[0].price;
        const spread = bestAsk - bestBid;
        const spreadBps = (spread / bestBid) * 10000;

        res.json({
            instrument,
            best_bid: parseFloat(bestBid.toFixed(8)),
            best_ask: parseFloat(bestAsk.toFixed(8)),
            spread: parseFloat(spread.toFixed(8)),
            spread_bps: parseFloat(spreadBps.toFixed(2)),
            mid_price: parseFloat(((bestBid + bestAsk) / 2).toFixed(8))
        });
    } catch (error) {
        console.error('Error calculating spread:', error);
        res.status(500).json({
            error: 'Failed to calculate spread',
            details: error.message
        });
    }
});

module.exports = router;
