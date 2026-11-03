
class Stoploss {
    constructor() {
        this.orders = [];
    }

    /**
     * add order to the positions
     * @param {*} optionInstrument 
     * @param {*} price 
     * @param {*} orderType 
     * @param {*} multiplier 
     */
    addOrder(optionInstrument, price, orderType, multiplier = 1) {
        let order = {
            "tradingsymbol": optionInstrument.tradingsymbol,
            "instrument_token": optionInstrument.instrument_token,
            "transaction_type": orderType,
            "quantity": optionInstrument.lot_size * multiplier,
            "average_price": price
        }
        this.orders.push(order);
    }

    positions() {
        let strategy_positions = {};
        this.orders.forEach((order) => {
            if (order.average_price != 0 && order.quantity != 0) {
                if (!strategy_positions[order.tradingsymbol]) {
                    strategy_positions[order.tradingsymbol] = {
                        "tradingsymbol": order.tradingsymbol,
                        "instrument_token": order.instrument_token,
                        "quantity": order.transaction_type == 'SELL' ? -1 * order.quantity : order.quantity,
                        "average_price": order.average_price,
                        "last_price": order.average_price,
                        "m2m": 0,
                        "sell_quantity": 0,
                        "sell_price": 0,
                        "sell_value": 0,
                        "buy_quantity": 0,
                        "buy_price": 0,
                        "buy_value": 0,
                    };

                    strategy_positions[order.tradingsymbol][(order.transaction_type).toLowerCase() + "_quantity"] = order.quantity;
                    strategy_positions[order.tradingsymbol][(order.transaction_type).toLowerCase() + "_price"] = order.average_price;
                    strategy_positions[order.tradingsymbol][(order.transaction_type).toLowerCase() + "_value"] = order.average_price * order.quantity;
                } else {
                    if (order.transaction_type == 'SELL') {
                        strategy_positions[order.tradingsymbol].quantity += -1 * order.quantity;
                        strategy_positions[order.tradingsymbol].sell_quantity += order.quantity;
                        strategy_positions[order.tradingsymbol].sell_value += Math.round(order.quantity * order.average_price);
                        strategy_positions[order.tradingsymbol].sell_price = Math.round(strategy_positions[order.tradingsymbol].sell_value / strategy_positions[order.tradingsymbol].sell_quantity * 100) / 100;
                    } else {
                        strategy_positions[order.tradingsymbol].quantity += order.quantity;
                        strategy_positions[order.tradingsymbol].buy_quantity += order.quantity;
                        strategy_positions[order.tradingsymbol].buy_value += Math.round(order.quantity * order.average_price);
                        strategy_positions[order.tradingsymbol].buy_price = Math.round(strategy_positions[order.tradingsymbol].buy_value / strategy_positions[order.tradingsymbol].buy_quantity * 100) / 100;
                    }
                }

                if (strategy_positions[order.tradingsymbol].quantity == 0) {
                    strategy_positions[order.tradingsymbol].m2m = strategy_positions[order.tradingsymbol].sell_value - strategy_positions[order.tradingsymbol].buy_value;
                }
            }
        });
        return strategy_positions;
    }

    /**
     * returns m2m of the positions
     * @param {*} ticksCache 
     * @returns 
     */
    getPNL(ticksCache) {
        let strategy_positions = this.positions();
        return Object.keys(strategy_positions).reduce(function (m2m, symbol) {
            let position = strategy_positions[symbol];
            if (ticksCache[position.instrument_token].last_price) {
                if (position.quantity > 0) {
                    position.m2m = ((position.sell_price * position.sell_quantity) + (Math.abs(position.quantity) * ticksCache[position.instrument_token].last_price)) - (position.buy_price * position.buy_quantity);
                } else if (position.quantity < 0) {
                    position.m2m = (position.sell_price * position.sell_quantity) - ((position.buy_price * position.buy_quantity) + (Math.abs(position.quantity) * ticksCache[position.instrument_token].last_price));
                }
            }
            return m2m + position.m2m;
        }, 0);
    }
}

module.exports = Stoploss;

// const tracker = new Stoploss();
// tracker.addOrder({
//     "tradingsymbol": "NIFTY21JUL16000PE",
//     "instrument_token": 123456,
//     "lot_size": 75
// }, 101, 'SELL');
// tracker.addOrder({
//     "tradingsymbol": "NIFTY21JUL16000PE",
//     "instrument_token": 123456,
//     "lot_size": 75
// }, 100, 'BUY');
// tracker.addOrder({
//     "tradingsymbol": "NIFTY21JUL16000PE",
//     "instrument_token": 123456,
//     "lot_size": 75
// }, 101, 'BUY');
// tracker.addOrder({
//     "tradingsymbol": "NIFTY21JUL16000PE",
//     "instrument_token": 123456,
//     "lot_size": 75
// }, 103, 'BUY');
// console.log(tracker.getPNL({
//     123456: {
//         last_price: 102
//     }
// }));


