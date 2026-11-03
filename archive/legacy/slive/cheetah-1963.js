const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;
const optionConfig = require('../tools/optionInstruments');
const async = require('async');
const otmSelector = require('../lib/otmSelector');
const moment = require('moment');

// Strategy Config
let channelId = 0;
// Cheetah_ST_60
let strategyTag = 'Cheetah_1963';

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

let positions = {
  accounts: []
};
async function checkPNL() {
  try {
    positions.accounts.forEach(async function (account, idx) {
      if (account.accountId == strategyTag && startTrade) {
        let total_m2m = 0;
        positions.accounts[idx].positions.forEach(function (position) {
          if (ticksCache[position.instrument_token]) {
            if (position.quantity > 0) {
              position.m2m = ((position.sell_price * position.sell_quantity) + (Math.abs(position.quantity) * ticksCache[position.instrument_token].last_price)) - (position.buy_price * position.buy_quantity);
            } else if (position.quantity < 0) {
              position.m2m = (position.sell_price * position.sell_quantity) - ((position.buy_price * position.buy_quantity) + (Math.abs(position.quantity) * ticksCache[position.instrument_token].last_price));
            }
            total_m2m += position.m2m;
          } else if (typeof position.m2m == 'number') {
            total_m2m += parseInt(position.m2m);
          }
        });
        positions.accounts[idx].total = total_m2m;
        positions.accounts[idx].totalAbs = Math.abs(positions.accounts[idx].total);
        console.log(total_m2m);

        if (isNaN(total_m2m)) fetchPositions();
        if (total_m2m > 2500) {
          optionOrders = [];
          startTrade = false;
          notify(strategyTag + ': TGT HIT', channelId);

          PaperTrade.positions(function (err, resp) {
            positions = resp;
            let openPositions = Object.values(positions.positions[strategyTag]).filter((pos) => (pos.quantity != 0));
            openPositions.forEach(async (order) => {
              Account.trackOrder({
                instrument_token: order.instrument_token,
                tradingsymbol: order.tradingsymbol,
                lot_size: Math.abs(order.quantity)
              }, (order.quantity > 0 ? 'SELL' : 'BUY'), strategyTag);
            });
          });
        }
      }
    });
  } catch (err) {
    console.log(err);
  }
}

let fetchingPosition = false;
async function fetchPositions() {
  if (!fetchingPosition) {
    fetchingPosition = true;
    PaperTrade.positions(function (err, resp) {
      fetchingPosition = false;
      positions = resp;
    });
  }
}

let accounts = [],
  running_accounts = [],
  account_quantities = {},
  firstRun = true;
async function getAccounts() {
  let accountsData = await Account.loadAccounts(strategyTag, firstRun);
  accounts = accountsData.accounts;
  account_quantities = accountsData.account_quantities;
  if (firstRun) {
    running_accounts = accountsData.running_accounts;
    firstRun = false;
  }
}

let futureToken, currentExpiryOptions = {},
  fromDate, toDate, farOtm, startTrade = false;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    if (moment().day() == 3) {
      currentExpiryOptions = optionData.nextWeekInstruments;
    }
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    farOtm = otmSelector('Cheetah');
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    setTimeout(placeTrade, 15000);
    // new CronJob('0 17 9 * * 1-5', placeTrade, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log('main err', err);
  }
}

let optionOrders = [],
  trail_sl = 60;

let ticksCache = {};
async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);

  // checkPNL();

  if (startTrade) {
    checkSLQ.push({
      check: 1
    });
  }
}

let tradeStart = true;
async function placeTrade() {
  let bn_quote;
  let checkQuote_attempt = 10;
  do {
    try {
      checkQuote_attempt--;
      bn_quote = ticksCache[futureToken];
      let new_ATM_Strike = (Math.round(bn_quote.last_price / 100) * 100);

      startTrade = true;

      if (tradeStart) {
        tradeStart = false;
        let typeBuy = bn_quote.last_price > bn_quote.ohlc.open ? 'PE' : 'CE';
        sendOrder(new_ATM_Strike, typeBuy);
      }
    } catch (err) {
      await zapi.login();
    }
  } while (typeof bn_quote != 'object' && checkQuote_attempt > 0);
}

async function sendOrder(new_ATM_Strike, typeBuy) {
  // console.log(new_ATM_Strike + typeBuy);
  let tradeStrike = parseInt(new_ATM_Strike);
  if (typeBuy == 'CE') tradeStrike += farOtm;
  else if (typeBuy == 'PE') tradeStrike -= farOtm;

  let ce_option = currentExpiryOptions[tradeStrike + typeBuy];
  let ce_ltp = ticksCache[ce_option.instrument_token].last_price;
  await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, ce_option, 'SELL');
  optionOrders.push({
    atm: new_ATM_Strike,
    strike: tradeStrike,
    type: typeBuy,
    instrument_token: ce_option.instrument_token,
    entry: ce_ltp,
    low: ce_ltp,
    sl_hit: false
  });
  // setTimeout(fetchPositions, 2000);
}

async function checkSL() {
  optionOrders.forEach(async (ce_position, idx) => {
    let check_option = ce_position;
    let current_price = ticksCache[check_option.instrument_token].last_price;
    ce_position.low = ce_position.low > current_price ? current_price : ce_position.low;
    let sl_price = ce_position.entry + (trail_sl - (ce_position.entry - ce_position.low));
    // console.log(current_price, sl_price, ce_position.entry, ce_position.high);
    if (ticksCache[check_option.instrument_token].last_price > sl_price) {
      delete optionOrders[idx];
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[check_option.strike + check_option.type], 'BUY');

      let bn_quote = ticksCache[futureToken];
      let new_ATM_Strike = (Math.round(bn_quote.last_price / 100) * 100);
      let typeBuy = check_option.type == 'PE' ? 'CE' : 'PE';
      sendOrder(new_ATM_Strike, typeBuy);

      return false;
    } else return true;
  });
}

var checkSLQ = async.queue(function (task, callback) {
  checkSL().then(function (res) {
    callback();
  });
}, 1);

runStrategy();
// new CronJob('50 16 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('50 23 15 * * 1-5', async function () {
  startTrade = false;
}, null, true, 'Asia/Kolkata');
new CronJob('0 30 15 * * 1-5', async function () {
  setTimeout(function () {
    process.exit();
  }, 15000);
}, null, true, 'Asia/Kolkata');
