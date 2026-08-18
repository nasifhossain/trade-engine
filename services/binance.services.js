const WebSocket = require('ws');

class BinanceService {
    constructor(orderServices) {
        this.orderServices = orderServices;
        this.ws = null;
        this.enabled = process.env.BINANCE_INGESTION_ENABLED === 'true';
        this.symbol = (process.env.BINANCE_INGESTION_SYMBOL || 'btcusdt').toLowerCase();
        // Fallback to Testnet because the main Binance stream is blocked by the ISP/network
        this.url = `wss://stream.testnet.binance.vision/ws/${this.symbol}@trade`;
        this.reconnectTimeout = null;
        this.isShuttingDown = false;

        // Throttling: default to 100ms (max 10 orders per second) to prevent DB overload
        this.throttleMs = parseInt(process.env.BINANCE_THROTTLE_MS) || 100;
        this.lastProcessedTime = 0;
    }

    start() {
        if (!this.enabled) {
            console.log('ℹ️ Binance ingestion is disabled.');
            return;
        }

        console.log(`Connecting to Binance WebSocket for ${this.symbol}...`);
        this.connect();
    }

    connect() {
        if (this.isShuttingDown) return;

        this.ws = new WebSocket(this.url);

        this.ws.on('open', () => {
            console.log(`✓ Connected to Binance WebSocket: ${this.url}`);
        });

        this.ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                
                // Binance trade event ('e' is event type)
                if (message.e === 'trade') {
                    const now = Date.now();
                    
                    // Phase 2: Throttling
                    if (now - this.lastProcessedTime < this.throttleMs) {
                        return; // Skip this trade to avoid database overload
                    }
                    this.lastProcessedTime = now;

                    const price = parseFloat(message.p);
                    const qty = parseFloat(message.q);
                    
                    // Since a Binance trade is a match between a buyer and seller, 
                    // we randomly assign a side to simulate organic two-way traffic
                    const side = Math.random() > 0.5 ? 'buy' : 'sell';
                    
                    // Convert Binance symbol format ('BTCUSDT') to our engine format ('BTC-USD')
                    const instrument = 'BTC-USD'; 

                    // Create the simulated order
                    const orderData = {
                        client_id: `binance_sim_${message.E}`,
                        instrument: instrument,
                        type: 'market',
                        side: side,
                        quantity: qty
                        // Market orders don't technically need a price in our engine, 
                        // but they will execute against the standing limit orders.
                    };

                    // Phase 3: Integration
                    if (this.orderServices) {
                        this.orderServices.createOrder(orderData)
                            .then(order => {
                                console.log(`[Binance Ingest] Executed ${side.toUpperCase()} ${qty} ${instrument} @ MKT`);
                            })
                            .catch(err => {
                                console.error('[Binance Ingest] Error creating order:', err.message);
                            });
                    } else {
                        // Fallback if orderServices wasn't provided
                        console.log(`[Binance Phase 2] Parsed simulated order:`, orderData);
                    }
                }
            } catch (error) {
                console.error('Error parsing Binance message:', error);
            }
        });

        this.ws.on('error', (error) => {
            console.error('Binance WebSocket error:', error.message);
        });

        this.ws.on('close', () => {
            console.log('Binance WebSocket closed.');
            if (!this.isShuttingDown) {
                console.log('Reconnecting to Binance in 5 seconds...');
                this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
            }
        });
    }

    stop() {
        this.isShuttingDown = true;
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }
        if (this.ws) {
            this.ws.close();
            console.log('✓ Binance WebSocket disconnected.');
        }
    }
}

module.exports = BinanceService;
