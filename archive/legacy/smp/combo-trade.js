const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const Spreads = app.models.spreads;
const PaperTrade = app.models.PaperTrade;
let eventIdx = 0;
const eventId = () => (eventIdx++);

PaperTrade.getDataSource().connector.connect(function (err, db) {
  console.log('datasource connected');
  const collection2 = db.collection("spreads");
  const changeStream2 = collection2.watch();
  changeStream2.on("change", async function (event) {
    try {
      // console.log(event);
      if (event.operationType == 'insert') {
        strategies.push(event.fullDocument);
        subscribeInstruments(event.fullDocument.trades);
      } else if (event.operationType == 'update') {
        if (event.updateDescription.updatedFields && event.updateDescription.updatedFields.running === true) {
          let documentId = String(event.documentKey._id);
          let strategy = await Spreads.findById(documentId);
          let strategyIdx = strategies.findIndex(row => String(row.id) === documentId || String(row._id) === documentId);

          console.log('adding', strategy.name, strategies.length);
          subscribeInstruments(strategy.trades);

          if (strategyIdx === -1)
            strategies.push(strategy);
          else
            strategies[strategyIdx] = strategy;
        } else if (event.updateDescription.updatedFields && event.updateDescription.updatedFields.running === false) {
          let documentId = String(event.documentKey._id);
          let strategyIdx = strategies.findIndex(row => String(row.id) === documentId || String(row._id) === documentId);

          if (strategyIdx !== -1) {
            strategies[strategyIdx].running = false;
          }
        }
      }
    } catch (err) {
      console.log(err);
    }
  });
})
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
    liveFeed.setMode(liveFeed.modeFull, subs);
  });
}

async function subscribeInstruments(trades) {
  let tokens = trades.map(trade => trade.instrument_token);
  liveFeed.subscribe(tokens);
  liveFeed.setMode(liveFeed.modeFull, tokens);
}

let futureToken, currentExpiryOptions = {};
let strategies = [];
async function runStrategy() {
  try {
    futureToken = 260105;

    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken]);

    let all_strategies = await Spreads.find();

    all_strategies.forEach(strategy => {
      if (strategy.running) {
        subscribeInstruments(strategy.trades);
        strategies.push(strategy);
      }
    });
  } catch (err) {
    console.log('main err', err);
  }
}

let ticksCache = {};
async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);

  checkSpreads();
}

async function sendOrder(trades, tag, perTrade, tradeType) {
  if (tradeType == 'entry') {
    trades.forEach(trade => {
      PaperTrade.trackOrder({
        tradingsymbol: trade.tradingsymbol,
        instrument_token: trade.instrument_token,
        lot_size: trade.lot_size,
      }, trade.trade_action, tag, trade.quantity * perTrade);
    });
  } else {
    trades.reverse().forEach(trade => {
      PaperTrade.trackOrder({
        tradingsymbol: trade.tradingsymbol,
        instrument_token: trade.instrument_token,
        lot_size: trade.lot_size,
      }, trade.trade_action == 'BUY' ? 'SELL' : 'BUy', tag, trade.quantity * perTrade);
    });
  }
}

function spreadPrice(trades) {
  try {
    let cmp = trades.reduce(function (cmp, trade) {
      if (trade.trade_action == 'BUY')
        cmp -= _SP_ask(trade.instrument_token) * trade.quantity;
      else if (trade.trade_action == 'SELL')
        cmp += _SP_bid(trade.instrument_token) * trade.quantity;

      return cmp;
    }, 0);

    return cmp;
  } catch (err) {
    return false;
  }
}

async function checkSpreads() {
  // console.log(strategies.length);
  strategies.forEach(function (strategy) {
    if (strategy) {
      let cmp = spreadPrice(strategy.trades);

      if (cmp && strategy.running) {
        console.log(strategy.name, cmp, strategy.entry_price, strategy.entry_quantity, strategy.exit_price, strategy.exit_quantity);

        if ((strategy.total_quantity - strategy.entry_quantity) > 0) {
          let trg = false;

          if (strategy.last_price >= strategy.entry_price && strategy.entry_price >= cmp) {
            trg = true;
          } else if (strategy.last_price <= strategy.entry_price && strategy.entry_price <= cmp) {
            trg = true;
          }

          if (trg) {
            sendOrder(strategy.trades, strategy.name, strategy.per_trade, 'entry');
            strategy.entry_quantity += strategy.per_trade;
            if (strategy.leap != 0) {
              strategy.entry_price = Math.round((strategy.entry_price + strategy.leap) * 10) / 10;
            }
            console.log(strategy.name, 'entering...', cmp);
            setTimeout(function () {
              strategy.save();
            }, 1500);
          }
        }

        if ((strategy.entry_quantity - strategy.exit_quantity) > 0) {
          let trg = false;
          if (strategy.last_price >= strategy.exit_price && strategy.exit_price >= cmp) {
            trg = true;
          } else if (strategy.last_price <= strategy.exit_price && strategy.exit_price <= cmp) {
            trg = true;
          }

          if (trg) {
            sendOrder(strategy.trades, strategy.name, strategy.per_trade, 'exit');
            strategy.exit_quantity += strategy.per_trade;
            if (strategy.leap != 0) {
              strategy.exit_price = Math.round((strategy.exit_price - strategy.leap) * 10) / 10;
            }
            console.log(strategy.name, 'exiting...', cmp);
            setTimeout(function () {
              strategy.save();
            }, 1000);
          }
        }

        strategy.last_price = cmp;
      }
    }
  });
}

const _TP = (token) => (ticksCache[token].last_price);
const _SP = (strike) => (Math.round(((ticksCache[token].depth.buy[0].price + ticksCache[currentExpiryOptions[strike].instrument_token].depth.sell[0].price) / 2) * 100) / 100);
const _SP_bid = (token) => (ticksCache[token].depth.buy[0].price);
const _SP_ask = (token) => (ticksCache[token].depth.sell[0].price);

// runStrategy();
new CronJob('0 15 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 29 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
