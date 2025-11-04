const express = require('express');
const router = express.Router();

/**
 * Metrics Routes
 * Prometheus-compatible metrics endpoint for monitoring and observability
 */

/**
 * GET /metrics
 * Returns metrics in Prometheus text format
 * Used by Prometheus, Grafana, and other monitoring systems
 */
router.get('/', async (req, res) => {
    try {
        const redisService = req.app.locals.redisService;

        // Fetch metrics from Redis
        const ordersReceived = parseInt(await redisService.redis.get('metrics:orders:received') || '0');
        const ordersMatched = parseInt(await redisService.redis.get('metrics:orders:matched') || '0');
        const ordersRejected = parseInt(await redisService.redis.get('metrics:orders:rejected') || '0');
        const tradesTotal = parseInt(await redisService.redis.get('metrics:trades:total') || '0');
        const ordersCancelled = parseInt(await redisService.redis.get('metrics:orders:cancelled') || '0');

        // Build Prometheus metrics
        let metricsText = '# HELP orders_received_total Total number of orders received\n';
        metricsText += '# TYPE orders_received_total counter\n';
        metricsText += `orders_received_total ${ordersReceived}\n\n`;

        metricsText += '# HELP orders_matched_total Total number of orders matched\n';
        metricsText += '# TYPE orders_matched_total counter\n';
        metricsText += `orders_matched_total ${ordersMatched}\n\n`;

        metricsText += '# HELP orders_rejected_total Total number of orders rejected\n';
        metricsText += '# TYPE orders_rejected_total counter\n';
        metricsText += `orders_rejected_total ${ordersRejected}\n\n`;

        metricsText += '# HELP orders_cancelled_total Total number of orders cancelled\n';
        metricsText += '# TYPE orders_cancelled_total counter\n';
        metricsText += `orders_cancelled_total ${ordersCancelled}\n\n`;

        metricsText += '# HELP trades_total Total number of trades executed\n';
        metricsText += '# TYPE trades_total counter\n';
        metricsText += `trades_total ${tradesTotal}\n\n`;

        // Order book depth gauge
        metricsText += '# HELP orderbook_depth Current depth of order book\n';
        metricsText += '# TYPE orderbook_depth gauge\n';
        metricsText += 'orderbook_depth{instrument="BTC-USD",side="bids"} 0\n';
        metricsText += 'orderbook_depth{instrument="BTC-USD",side="asks"} 0\n\n';

        // Application info
        metricsText += '# HELP app_info Application metadata\n';
        metricsText += '# TYPE app_info gauge\n';
        metricsText += `app_info{version="1.0.0",name="trade-clearing-engine"} 1\n`;

        // Success rate
        const matchRate = ordersReceived > 0 ? (ordersMatched / ordersReceived * 100).toFixed(2) : 0;
        metricsText += '\n# HELP order_match_rate_percent Percentage of orders that resulted in matches\n';
        metricsText += '# TYPE order_match_rate_percent gauge\n';
        metricsText += `order_match_rate_percent ${matchRate}\n`;

        res.set('Content-Type', 'text/plain; charset=utf-8');
        res.send(metricsText);
    } catch (error) {
        console.error('Error generating metrics:', error);
        res.status(500).send('Error generating metrics');
    }
});

module.exports = router;
