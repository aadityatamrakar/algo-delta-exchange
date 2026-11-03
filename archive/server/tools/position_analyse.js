const request = require('request');

async function getReq(url) {
    return new Promise((resolve, reject) => {
        var options = {
            'method': 'GET',
            'url': url,
            'json': true,
        };
        request(options, function (error, response) {
            if (error) throw new Error(error);
            resolve(response.body);
        });
    });
}

async function postRequest(url, data) {
    return new Promise((resolve, reject) => {
        var options = {
            'method': 'POST',
            headers: {
                'cache-control': 'no-cache',
                'content-type': 'application/json;charset=UTF-8',
            }
        }
        options.url = url;
        options.json = true;
        options.body = data;
        request(options, function (error, response) {
            if (error) throw new Error(error);
            resolve(response.body);
        });
    });
}

async function anaylyse(trades, cb) {
    // let trades = fs.readFileSync('trades.json', 'utf8');
    // trades = JSON.parse(trades);

    let instruments = await getReq('https://oxide.sensibull.com/v1/compute/cache/live_derivative_prices/260105');
    let atm_iv_per_expiry = Object.keys(instruments.data.per_expiry_data).reduce((s, a) => {
        s[a] = instruments.data.per_expiry_data[a].atm_iv || 0;
        return s;
    }, {})
    let current_underlying_price = instruments.data.underlying_price;
    let last_updated_at = instruments.data.last_updated_at;
    let expiry_list = Object.keys(instruments.data.per_expiry_data).sort((a, b) => {
        let a1 = a.split('-');
        let b1 = b.split('-');
        return new Date(a1[0], a1[1], a1[2]) - new Date(b1[0], b1[1], b1[2]);
    });
    // console.log(expiry_list);
    let futures_per_expiry = {
        [expiry_list[0]]: instruments.data.per_expiry_data[expiry_list[0]].future_price
    };

    let instrument_iv = instruments.data.per_expiry_data[expiry_list[0]].options.reduce((s, a) => {
        s[a.token] = a.greeks_with_iv.iv;
        return s;
    }, {});

    trades = trades
        .filter(c => c.status == 'Filled')
        .map(order => {
            return {
                "instrument_token": parseInt(order.instrument_token),
                "entry_price": order.average_price,
                "trade_action": order.transaction_type == 'BUY' ? "Buy" : "Sell",
                "quantity": order.quantity / 25,
                "implied_volatility": instrument_iv[order.instrument_token],
                "tag": "leg:" + order.id,
                "booked_profit_loss": 0
            };
        });


    let data = {
        "underlying_token": 260105,
        "current_underlying_price": current_underlying_price,
        "atm_iv_per_expiry": atm_iv_per_expiry,
        "target_underlying_price": current_underlying_price,
        "target_datetime": last_updated_at.substring(0, 10) + "T09:45:00.000Z",
        "futures_per_expiry": futures_per_expiry,
        "trades": trades,
        "expired_trades": []
    }

    // console.log(data);

    // fs.writeFileSync('builder.json', JSON.stringify(data, null, 2));

    let result = await postRequest('https://oxide.sensibull.com/v1/compute/1/builder?enable_per_lot=true&enable_payoff_chart=true&enable_trade_details=false&enable_factor_booked_pnl=false', data);
    // console.log(result);
    result.payload.underlying_price = current_underlying_price;
    result.payload.payoffs_at_target = result.payload.payoffs_at_target
        .filter(c => c.at > current_underlying_price - 2000 && c.at < current_underlying_price + 2000)
    result.payload.payoffs_at_expiry = result.payload.payoffs_at_expiry
        .filter(c => c.at > current_underlying_price - 2000 && c.at < current_underlying_price + 2000)
    cb(null, result);
}

module.exports = anaylyse;
