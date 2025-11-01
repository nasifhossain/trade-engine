class Algo {
    constructor() {
        // Order books: bids (buy orders) and asks (sell orders)
        this.bids = []; // Buy orders - sorted by price DESC, then time ASC
        this.asks = []; // Sell orders - sorted by price ASC, then time ASC
        this.trades = []; // Executed trades
        this.orderIdCounter = 1;
        this.timestampCounter = 0; // For ensuring unique, sequential timestamps
    }

    /**
     * Add a buy order to the order book
     * @param {number} price - Price per unit
     * @param {number} quantity - Quantity to buy
     * @param {string} userId - User ID placing the order
     * @returns {object} Order object
     */
    addBuyOrder(price, quantity, userId = 'default') {
        const order = {
            id: this.orderIdCounter++,
            type: 'BUY',
            price,
            quantity,
            originalQuantity: quantity,
            userId,
            timestamp: this.timestampCounter++
        };

        this.bids.push(order);
        this._sortBids();
        this._matchOrders();

        return order;
    }

    /**
     * Add a sell order to the order book
     * @param {number} price - Price per unit
     * @param {number} quantity - Quantity to sell
     * @param {string} userId - User ID placing the order
     * @returns {object} Order object
     */
    addSellOrder(price, quantity, userId = 'default') {
        const order = {
            id: this.orderIdCounter++,
            type: 'SELL',
            price,
            quantity,
            originalQuantity: quantity,
            userId,
            timestamp: this.timestampCounter++
        };

        this.asks.push(order);
        this._sortAsks();
        this._matchOrders();

        return order;
    }

    /**
     * Sort buy orders: highest price first, then earliest time
     */
    _sortBids() {
        this.bids.sort((a, b) => {
            if (b.price !== a.price) {
                return b.price - a.price; // Higher price first
            }
            return a.timestamp - b.timestamp; // Earlier time first
        });
    }

    /**
     * Sort sell orders: lowest price first, then earliest time
     */
    _sortAsks() {
        this.asks.sort((a, b) => {
            if (a.price !== b.price) {
                return a.price - b.price; // Lower price first
            }
            return a.timestamp - b.timestamp; // Earlier time first
        });
    }

    /**
     * Match buy and sell orders
     * Matching occurs when bid price >= ask price
     */
    _matchOrders() {
        while (this.bids.length > 0 && this.asks.length > 0) {
            const bestBid = this.bids[0];
            const bestAsk = this.asks[0];

            // Check if orders can match (bid price >= ask price)
            if (bestBid.price >= bestAsk.price) {
                // Execute trade at the maker's price (order that was on the book first)
                // The maker is the order with earlier timestamp (already on the book)
                // The taker is the incoming order that crosses the spread
                const executionPrice = bestBid.timestamp < bestAsk.timestamp 
                    ? bestBid.price  // Bid was on book first, use bid price
                    : bestAsk.price; // Ask was on book first, use ask price

                const executionQuantity = Math.min(bestBid.quantity, bestAsk.quantity);

                // Record the trade
                const trade = {
                    id: this.trades.length + 1,
                    buyOrderId: bestBid.id,
                    sellOrderId: bestAsk.id,
                    price: executionPrice,
                    quantity: executionQuantity,
                    buyer: bestBid.userId,
                    seller: bestAsk.userId,
                    timestamp: Date.now()
                };

                this.trades.push(trade);

                // Update order quantities
                bestBid.quantity -= executionQuantity;
                bestAsk.quantity -= executionQuantity;

                // Remove fully filled orders
                if (bestBid.quantity === 0) {
                    this.bids.shift();
                }
                if (bestAsk.quantity === 0) {
                    this.asks.shift();
                }
            } else {
                // No more matches possible
                break;
            }
        }
    }

    /**
     * Get the current order book
     * @returns {object} Order book with bids and asks
     */
    getOrderBook() {
        return {
            bids: this.bids.map(order => ({
                price: order.price,
                quantity: order.quantity,
                userId: order.userId
            })),
            asks: this.asks.map(order => ({
                price: order.price,
                quantity: order.quantity,
                userId: order.userId
            }))
        };
    }

    /**
     * Get all executed trades
     * @returns {array} Array of trade objects
     */
    getTrades() {
        return [...this.trades];
    }

    /**
     * Get the best bid (highest buy price)
     * @returns {number|null} Best bid price or null if no bids
     */
    getBestBid() {
        return this.bids.length > 0 ? this.bids[0].price : null;
    }

    /**
     * Get the best ask (lowest sell price)
     * @returns {number|null} Best ask price or null if no asks
     */
    getBestAsk() {
        return this.asks.length > 0 ? this.asks[0].price : null;
    }

    /**
     * Get the current spread (difference between best bid and best ask)
     * @returns {number|null} Spread or null if incomplete order book
     */
    getSpread() {
        const bestBid = this.getBestBid();
        const bestAsk = this.getBestAsk();
        return (bestBid !== null && bestAsk !== null) ? bestAsk - bestBid : null;
    }

    /**
     * Cancel an order by ID
     * @param {number} orderId - Order ID to cancel
     * @returns {boolean} True if order was cancelled, false if not found
     */
    cancelOrder(orderId) {
        // Try to find in bids
        const bidIndex = this.bids.findIndex(order => order.id === orderId);
        if (bidIndex !== -1) {
            this.bids.splice(bidIndex, 1);
            return true;
        }

        // Try to find in asks
        const askIndex = this.asks.findIndex(order => order.id === orderId);
        if (askIndex !== -1) {
            this.asks.splice(askIndex, 1);
            return true;
        }

        return false;
    }

    /**
     * Clear all orders and trades (for testing)
     */
    reset() {
        this.bids = [];
        this.asks = [];
        this.trades = [];
        this.orderIdCounter = 1;
        this.timestampCounter = 0;
    }
}

module.exports = Algo;

