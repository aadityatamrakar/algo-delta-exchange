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
let strategyTag = 'Dolphin-0020';
let target_profit = 70;

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
            // console.log(1, position.tradingsymbol, position.m2m, total_m2m);
          } else if (typeof position.m2m == 'number') {
            total_m2m += parseInt(position.m2m);
            // console.log(2, position.tradingsymbol, position.m2m, total_m2m);
          }
        });
        positions.accounts[idx].total = total_m2m;
        positions.accounts[idx].totalAbs = Math.abs(positions.accounts[idx].total);

        // if (isNaN(total_m2m)) fetchPositions();
        if (total_m2m > 10000) {
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

let futureToken, currentExpiryOptions = {},
  vixToken = 264969;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    if (moment().day() == 3 || moment().day() == 4) {
      currentExpiryOptions = optionData.nextWeekInstruments;
    }
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    farOtm = 200;
    // await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([vixToken, futureToken, ...optionTokens]);

    setTimeout(function () {
      lastQuote = ticksCache[futureToken].last_price;
      startTrade = true;
      console.log('startTrade: true');
    }, 10000);
  } catch (err) {
    console.log('main err', err);
  }
}

let optionOrders = false,
  ATM_Strike = [],
  positionsOpen = [];

let ticksCache = {},
  startTrade = false;
async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);

  // checkPNL();

  if (startTrade) {
    takePositionQ.push({
      check: 1
    });
  }

  checkSLQ.push({
    check: 1
  });
}

let farOtm = 200,
  lastQuote = 0,
  mid_price;
async function placeTrade() {
  let bn_quote = ticksCache[futureToken];
  let new_ATM_Strike;
  if (mid_price) {
    if (bn_quote.last_price > mid_price) new_ATM_Strike = mid_price + 200;
    else if (bn_quote.last_price < mid_price) new_ATM_Strike = mid_price - 200;
  } else {
    new_ATM_Strike = (Math.round(bn_quote.last_price / 100) * 100);
  }

  let pe_option, ce_option;

  if (new_ATM_Strike) {
    ce_option = currentExpiryOptions[(new_ATM_Strike + farOtm) + "CE"];
    pe_option = currentExpiryOptions[(new_ATM_Strike - farOtm) + "PE"];
  }

  let takePosition = false,
    isCrossover = false;
  if (new_ATM_Strike && bn_quote.last_price >= new_ATM_Strike && lastQuote <= new_ATM_Strike) {
    isCrossover = true;
  } else if (new_ATM_Strike && bn_quote.last_price <= new_ATM_Strike && lastQuote >= new_ATM_Strike) {
    isCrossover = true;
  }
  lastQuote = bn_quote.last_price;

  if (isCrossover && optionOrders && optionOrders.atm != new_ATM_Strike) {
    let tmpOrder = Object.assign({}, optionOrders);
    optionOrders = false;
    await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[tmpOrder.ce_strike + 'CE'], 'BUY', 1);
    await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[tmpOrder.pe_strike + 'PE'], 'BUY', 1);
    takePosition = true;
  } else if (isCrossover && optionOrders == false) {
    takePosition = true;
  }

  if (takePosition) {
    let ce_ltp = ticksCache[ce_option.instrument_token].last_price;
    let pe_ltp = ticksCache[pe_option.instrument_token].last_price;
    await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, ce_option, 'SELL', 1);
    await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, pe_option, 'SELL', 1);
    optionOrders = {
      atm: new_ATM_Strike,
      ce_strike: ce_option.strike,
      ce_token: ce_option.instrument_token,
      pe_strike: pe_option.strike,
      pe_token: pe_option.instrument_token,
      entry: ce_ltp + pe_ltp,
      target: (ce_ltp + pe_ltp) - target_profit,
      sl_hit: false
    };
    mid_price = new_ATM_Strike;
    console.log('new mp: ' + mid_price);
    return true;
  } else return false;
}

async function checkSL() {
  if (optionOrders) {
    let tmpOrder = Object.assign({}, optionOrders);
    let ce_ltp = ticksCache[optionOrders.ce_token].last_price;
    let pe_ltp = ticksCache[optionOrders.pe_token].last_price;
    let current_price = (ce_ltp + pe_ltp);
    if (current_price < optionOrders.target) {
      optionOrders = false;
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[tmpOrder.ce_strike + 'CE'], 'BUY', 1);
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[tmpOrder.pe_strike + 'PE'], 'BUY', 1);
      return false;
    } else return true;
  } else return true;
}

var takePositionQ = async.queue(function (task, callback) {
  placeTrade().then(function (res) {
    callback();
  });
}, 1);
var checkSLQ = async.queue(function (task, callback) {
  checkSL().then(function (res) {
    callback();
  });
}, 1);

runStrategy();