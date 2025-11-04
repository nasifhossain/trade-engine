/**
 * K6 Load Test for Trade Clearing Engine
 * Tests system performance under sustained load (target: 2,000 orders/sec)
 * 
 * Run with: k6 run load-tests/k6-load-test.js
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend, Counter, Gauge } from 'k6/metrics';

// Define custom metrics
const orderSuccessRate = new Rate('order_success_rate');
const orderFailureRate = new Rate('order_failure_rate');
const orderLatency = new Trend('order_latency_ms');
const tradesExecuted = new Counter('trades_executed');
const activeVUs = new Gauge('active_vus');
const ordersPerSecond = new Gauge('orders_per_second');

// Test configuration
export const options = {
    stages: [
        { duration: '30s', target: 100, name: 'Ramp-up to 100 VUs' },
        { duration: '1m', target: 500, name: 'Ramp-up to 500 VUs' },
        { duration: '2m', target: 2000, name: 'Sustained load at 2000 VUs' },
        { duration: '1m', target: 500, name: 'Ramp-down to 500 VUs' },
        { duration: '30s', target: 0, name: 'Cool down' }
    ],
    thresholds: {
        'order_latency_ms': ['p(95)<100', 'p(99)<150', 'p(99.9)<200'],
        'order_success_rate': ['rate>0.95'],
        'order_failure_rate': ['rate<0.05'],
        'http_req_failed': ['rate<0.05']
    },
    ext: {
        loadimpact: {
            projectID: 0, // Replace with actual project ID
            name: 'Trade Clearing Engine Load Test'
        }
    }
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// Test data generators
function generateOrder() {
    const sides = ['buy', 'sell'];
    const types = ['limit', 'market'];
    const instruments = ['BTC-USD', 'ETH-USD', 'ADA-USD'];

    const side = sides[Math.floor(Math.random() * sides.length)];
    const type = types[Math.floor(Math.random() * types.length)];
    const instrument = instruments[Math.floor(Math.random() * instruments.length)];
    const basePrice = instrument === 'BTC-USD' ? 70000 : instrument === 'ETH-USD' ? 3500 : 1;

    return {
        client_id: `client-${__VU}-${__ITER}`,
        instrument,
        side,
        type,
        price: type === 'limit' ? basePrice + (Math.random() - 0.5) * basePrice * 0.01 : undefined,
        quantity: 0.1 + Math.random() * 0.9
    };
}

export default function (data) {
    // Track active VUs
    activeVUs.add(__VU);
    ordersPerSecond.add(__VU / 10); // Approximate orders/second

    group('Order Creation Workflow', () => {
        const order = generateOrder();
        const payload = JSON.stringify(order);
        const idempotencyKey = `${__VU}-${__ITER}-${Date.now()}`;

        // Create order
        const createRes = http.post(`${BASE_URL}/api/orders/orders`, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': idempotencyKey,
                'User-Agent': 'k6-load-test'
            },
            tags: { name: 'CreateOrder' }
        });

        const createSuccess = check(createRes, {
            'create order status 201': (r) => r.status === 201,
            'create order response time < 50ms': (r) => r.timings.duration < 50,
            'create order response time < 100ms': (r) => r.timings.duration < 100,
            'create order response time < 150ms': (r) => r.timings.duration < 150,
            'has order_id': (r) => {
                try {
                    return JSON.parse(r.body).order?.order_id !== undefined;
                } catch {
                    return false;
                }
            }
        });

        orderLatency.add(createRes.timings.duration);
        if (createSuccess) {
            orderSuccessRate.add(true);
            const responseBody = JSON.parse(createRes.body);
            if (responseBody.match_result?.trades_executed > 0) {
                tradesExecuted.add(responseBody.match_result.trades_executed);
            }
        } else {
            orderFailureRate.add(true);
        }
    });

    group('Order Book Retrieval', () => {
        const bookRes = http.get(`${BASE_URL}/api/orders/orderbook?instrument=BTC-USD&levels=20`, {
            tags: { name: 'GetOrderBook' }
        });

        check(bookRes, {
            'orderbook status 200': (r) => r.status === 200,
            'orderbook response time < 30ms': (r) => r.timings.duration < 30,
            'orderbook has structure': (r) => {
                try {
                    const body = JSON.parse(r.body);
                    return body.bids && body.asks && Array.isArray(body.bids) && Array.isArray(body.asks);
                } catch {
                    return false;
                }
            }
        });
    });

    group('Analytics Queries', () => {
        const vwapRes = http.get(`${BASE_URL}/api/analytics/vwap?instrument=BTC-USD&window=60`, {
            tags: { name: 'GetVWAP' }
        });

        check(vwapRes, {
            'vwap status 200': (r) => r.status === 200,
            'vwap response time < 100ms': (r) => r.timings.duration < 100

        });

        const ohlcRes = http.get(`${BASE_URL}/api/analytics/ohlc?instrument=BTC-USD&interval=5`, {
            tags: { name: 'GetOHLC' }
        });

        check(ohlcRes, {
            'ohlc status 200': (r) => r.status === 200,
            'ohlc response time < 150ms': (r) => r.timings.duration < 150
        });
    });

    group('Metrics & Health', () => {
        const metricsRes = http.get(`${BASE_URL}/api/metrics`, {
            tags: { name: 'GetMetrics' }
        });

        check(metricsRes, {
            'metrics status 200': (r) => r.status === 200,
            'metrics contains counters': (r) => r.body.includes('orders_received_total')
        });

        const healthRes = http.get(`${BASE_URL}/healthz`, {
            tags: { name: 'HealthCheck' }
        });

        check(healthRes, {
            'health status 200': (r) => r.status === 200,
            'health response time < 10ms': (r) => r.timings.duration < 10
        });
    });

    // Small random delay to avoid thundering herd
    sleep(Math.random() * 0.5);
}

/**
 * Setup phase - run once before test
 */
export function setup() {
    console.log('Starting load test...');
    console.log(`Target: ${BASE_URL}`);
    
    // Warmup request
    const warmupRes = http.get(`${BASE_URL}/healthz`);
    check(warmupRes, {
        'warmup status 200': (r) => r.status === 200
    });

    return { startTime: Date.now() };
}

/**
 * Teardown phase - run once after test
 */
export function teardown(data) {
    console.log('Load test completed');
    console.log(`Test duration: ${(Date.now() - data.startTime) / 1000}s`);
}
