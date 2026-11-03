const CronJob = require("cron").CronJob;
const ws = require('ws');
const fs = require('fs');
const moment = require('moment');
var request = require('request');
const httpServer = require("http").createServer();
const io = require("socket.io")(httpServer, {});
httpServer.listen(3000);

let dollar_rate = 79;
let mcx_options = [], mcx_strikes = [];
let ticksCache_ibkr = {};
let crude_nymex = {};
let localSymbol = {}; // "CL": "256019320", "256019320": "CL" 

// io connection 
io.on('connection', (socket) => {
    console.log('a user connected');
    socket.emit('dollar_rate', { rate: dollar_rate });
    socket.on('dollar_rate', (rate) => {
        dollar_rate = rate;
        console.log(`update dollar_rate: ${dollar_rate}`);

        Object.keys(ticksCache_ibkr).forEach((tickKey) => {
            let mcx_idx = getMCXOption(tickKey);
            ticksCache_ibkr[tickKey].mcx = mcx_options[mcx_idx];
            ticksCache_ibkr[tickKey].nymex.rupee_strike = mcx_options[mcx_idx].strike;
            setPrice(tickKey);
        });
    });

    Object.keys(ticksCache_ibkr).forEach(elm => {
        socket.emit('ticks', ticksCache_ibkr[elm]);
    });
    socket.on('disconnect', () => {
        console.log('user disconnected');
    });
});

function getMCXOption(localSymbol) {
    let [symbol, strike] = localSymbol.split(' ');
    let strikePrice = parseFloat(strike.substring(1));
    let rupee_strike = (strikePrice / 100) * dollar_rate;
    let mcx_strike = mcx_strikes.reduce((prev, curr) => {
        return Math.abs(curr - rupee_strike) < Math.abs(prev - rupee_strike) ? curr : prev;
    }, mcx_strikes[0]);
    let mcx_index = mcx_options.findIndex(elm => {
        if (strike[0] == 'C') {
            return elm.strike == mcx_strike && elm.instrument_type == 'CE';
        } else {
            return elm.strike == mcx_strike && elm.instrument_type == 'PE';
        }
    });
    // console.log(mcx_index, localSymbol, strikePrice, rupee_strike, mcx_strike);
    return mcx_index;
}

async function connect_ibkr() {
    // ibkr stream token
    const userId = "61dbb9868711c706a09da4cb";
    const token = "SO5FdSPVi1cnPnY3IHiwgDlOzMfVKSGx7ePE85F9Lq4qHHzjHdFiDB1AScLnaF0c";
    const server_url = `ws://34.226.101.109/socket.io/?token=${token}&EIO=4&transport=websocket`;
    // connect to ibkr stream
    const ws_client = new ws(server_url);

    ws_client.on('open', () => {
        console.log('connected to ibkr stream');
        ws_client.send('40'); // connect ack    
    });

    // receive data from ibkr stream
    ws_client.on('message', (data) => {
        try {
            if (data == 2) ws_client.send(3);
            let tick = JSON.parse(data.slice(2));
            // console.log(tick);
            if (tick[0] == 'ticks' && tick[1][0].s in ticksCache_ibkr) {
                ticksCache_ibkr[tick[1][0].s].nymex.price = tick[1][0].p;
                setPrice(tick[1][0].s);
            } else if (tick[0] == 'ticks' && tick[1] && tick[1][0] && tick[1][0].s && tick[1][0].s.indexOf(' ') !== -1) {
                let [symbol, strike] = tick[1][0].s.split(' ');
                let mcx_idx = getMCXOption(tick[1][0].s);

                ticksCache_ibkr[tick[1][0].s] = {
                    nymex: {
                        price: tick[1][0].p,
                        timestamp: moment().utc("+5:30").format("YYYY-MM-DD HH:mm:ss"),
                        conId: localSymbol[tick[1][0].s],
                        symbol: symbol,
                        localSymbol: tick[1][0].s,
                        strike: strike,
                        type: strike[0],
                        rupee_strike: mcx_options[mcx_idx].strike,
                        exchange: "NYMEX"
                    },
                    mcx: mcx_options[mcx_idx]
                };
                setPrice(tick[1][0].s);
            }
        } catch (err) {
            // console.log(err);
        }
    });

}

const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const InstrumentDb = app.models.instrument;
const optionConfig = require('../tools/optionInstruments');

let zapi;
let public_token;
async function zerodha_init(account) {
    let zapi_n = new zerodha();
    zapi_n.loadConfig(account);
    let login_resp = await zapi_n.login();
    account.lastLogin = (new Date()).toISOString().substr(0, 10);
    account.config = await zapi_n.getConfig();
    public_token = zapi_n.getAuthorization();
    await account.save();
    if (login_resp === false) return false;
    else return zapi_n;
}

let liveFeed;
async function ticker(subs) {
    liveFeed = new kiteTicker({
        api_key: 'kitefront',
        access_token: public_token
    });
    liveFeed.connect();
    liveFeed.on("ticks", checkTicks);
    liveFeed.on("connect", function () {
        console.log('Live Feed Connected');
        liveFeed.subscribe(subs);
        liveFeed.setMode(liveFeed.modeLTP, subs);
    });
}

let futureToken, currentExpiryOptions = {};
async function runStrategy() {
    try {
        futureToken = 60292359; // CRUDEOIL22JULFUT;
        mcx_options = await InstrumentDb.find({});
        // console.log(mcx_options);
        let expiryList = Array.from(new Set(mcx_options.map(c => c.expiry)));
        // expiryList = expiryList.sort((a, b) => moment(a, 'YYYY-MM-DD').diff(moment(b, 'YYYY-MM-DD')));
        // console.log(expiryList);
        expiryList = ['2022-08-17'];
        mcx_options = mcx_options.filter(c => c.expiry === expiryList[0] && c.segment == "MCX-OPT" && c.name == "CRUDEOIL");
        currentExpiryOptions = mcx_options.reduce((obj, elm) => {
            if (elm.strike % 100 === 0) {
                obj[elm.strike + elm.instrument_type] = {
                    expiry: elm.expiry,
                    instrument_token: elm.instrument_token,
                    instrument_type: elm.instrument_type,
                    lot_size: elm.lot_size,
                    name: elm.name,
                    segment: elm.segment,
                    strike: parseInt(elm.strike),
                    tradingsymbol: elm.tradingsymbol,
                };
            }
            return obj;
        }, {});
        mcx_strikes = Object.values(currentExpiryOptions).map(c => parseInt(c.strike));
        console.log(`mcx_strikes: ${mcx_strikes}`);
        let optionTokens = Object.values(currentExpiryOptions).map(c => parseInt(c.instrument_token));
        let masterId = app.get('masterId');
        let base_acc = await Account.findById(masterId);
        zapi = await zerodha_init(base_acc);
        ticker([futureToken, ...optionTokens]);

        setTimeout(connect_ibkr, 3000);
    } catch (err) {
        console.log(err);
    }
}

let ticksCache = {};
async function checkTicks(ticks) {
    let ticks2 = ticks.reduce(function (ob, el) {
        ob[el.instrument_token] = el;
        return ob;
    }, {});
    Object.assign(ticksCache, ticks2);
    // console.log(Object.keys(ticksCache));

    Object.keys(ticksCache_ibkr).forEach(setPrice);
}

async function setPrice($idx) {
    // console.log(ticksCache_ibkr[$idx]);
    // console.log(Object.values(ticksCache_ibkr).map(c => parseInt(c.mcx.instrument_token)).map(c => ticksCache[c]));
    // console.log(ticksCache_ibkr[$idx], ticksCache_ibkr[$idx].mcx, ticksCache_ibkr[$idx].mcx.instrument_token, ticksCache[ticksCache_ibkr[$idx].mcx.instrument_token]);
    if (ticksCache_ibkr[$idx] && ticksCache_ibkr[$idx].mcx && ticksCache_ibkr[$idx].mcx.instrument_token && ticksCache[ticksCache_ibkr[$idx].mcx.instrument_token] && ticksCache[ticksCache_ibkr[$idx].mcx.instrument_token].last_price) {
        ticksCache_ibkr[$idx].nymex.price_inr = ticksCache_ibkr[$idx].nymex.price * dollar_rate;
        ticksCache_ibkr[$idx].mcx.price = ticksCache[ticksCache_ibkr[$idx].mcx.instrument_token].last_price;
        ticksCache_ibkr[$idx].diff = ticksCache_ibkr[$idx].mcx.price - ticksCache_ibkr[$idx].nymex.price_inr;
        io.emit('ticks', ticksCache_ibkr[$idx]);
    }
}

function init() {
    var options = {
        'method': 'GET',
        'url': 'http://34.226.101.109/crude.json',
        gzip: true,
        json: true
    };
    request(options, function (error, response) {
        // if (error) throw new Error(error);
        crude_nymex = response.body;
        localSymbol = Object.values(crude_nymex.options).reduce(function (obj, item) {
            obj[item.localSymbol] = item.conId;
            obj[item.conId] = item.localSymbol;
            return obj;
        }, {});
        // console.log(localSymbol);
        // fs.writeFileSync('crude.json', JSON.stringify(crude_nymex));

        runStrategy();
    });
}

// init();
new CronJob('0 10 2 * * 1-5', init, null, true, 'Asia/Kolkata');
new CronJob('0 50 1 * * 1-5', function () {
    setTimeout(function () {
        process.exit();
    }, 3000);
}, null, true, 'Asia/Kolkata');
