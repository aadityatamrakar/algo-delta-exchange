const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker.js');
const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;
const optionConfig = require('../tools/optionInstruments.js');
const moment = require('moment');
const async = require('async');
const pause = async (ms) => (new Promise((r, c) => setTimeout(r, ms)));
const PositionTracker = require('../tools/stoploss.js');
const Orderbook = new PositionTracker();

// Strategy Config
let channelId = 0;
let strategyTag = 'BMW-M40dST';
let OTM = 100, max_sl_count = 2;

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

let futureToken, farOtm = 0,
  currentExpiryOptions = {};
async function runStrategy() {
  try {
    let optionData = await optionConfig('MIDCPNIFTY');
    futureToken = 288009;
    currentExpiryOptions = optionData.weeklyInstruments;
    // if (moment().day() == 3) {
    //   currentExpiryOptions = optionData.nextWeekInstruments;
    // }
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    // farOtm = otmSelector();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);
    await getAccounts();

    setTimeout(takeTrade, 20000);
    new CronJob('30 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');

  } catch (err) {
    console.log(err);
  }
}

let init_pending = true,
  ticksCache = {};
async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);

  onTickCheckStoploss();
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


let MOVE_OTM = 100,
  SL_percent = 1.40,
  Tgt_percent = 0.50,
  minimum_price = 5,
  signal = true,
  optionOrders = {};
async function takeTrade() {

  try {
    if (signal) {
      signal = false;
      let bn_quote = ticksCache[futureToken];
      if (bn_quote === undefined) {
        signal = true;
        setTimeout(takeTrade, 1000);
        return;
      }
      let atm = (Math.round(bn_quote.last_price / 100) * 100);

      sendPairOrder('SELL', atm);
      let ce_ltp = ticksCache[currentExpiryOptions[(atm + OTM) + "CE"].instrument_token].last_price;
      let pe_ltp = ticksCache[currentExpiryOptions[(atm - OTM) + "PE"].instrument_token].last_price;

      optionOrders = {
        ce_strike: atm,
        pe_strike: atm,
        risk_down_ce: ce_ltp * SL_percent,
        risk_up_ce: ce_ltp * Tgt_percent,
        risk_down_pe: pe_ltp * SL_percent,
        risk_up_pe: pe_ltp * Tgt_percent,
      };

      console.log(optionOrders);
    }

  } catch (err) {
    console.log(err);
  }

}

let stoploss_limit = -1200;
let trail_trg = 1200;
async function onTickCheckStoploss() {
  if (optionOrders) {
    let bn_quote = ticksCache[futureToken];
    let atm = (Math.round(bn_quote.last_price / 100) * 100);

    let pnl = Orderbook.getPNL(ticksCache);
    // console.log(`PNL: ${pnl}\tSL: ${stoploss_limit}`)
    if (pnl < stoploss_limit) {
      console.log('STOPLOSS HIT');
      if (optionOrders.ce_strike) {
        sendPairOrder('BUY', optionOrders.ce_strike, 'CE');
        optionOrders.ce_strike = false;
      }
      if (optionOrders.pe_strike) {
        sendPairOrder('BUY', optionOrders.pe_strike, 'PE');
        optionOrders.pe_strike = false;
      }
      return false;
    }

    if (trail_trg && pnl > trail_trg) {
      console.log('TRAILING STOPLOSS');
      stoploss_limit = 0;
      trail_trg = false;
    }

    if (optionOrders.ce_strike) {
      let ce_ltp = ticksCache[currentExpiryOptions[(optionOrders.ce_strike + OTM) + "CE"].instrument_token];
      if (!ce_ltp) return;
      ce_ltp = ce_ltp.last_price;
      if (ce_ltp > optionOrders.risk_down_ce) {
        sendPairOrder('BUY', optionOrders.ce_strike, 'CE');
        max_sl_count--;
        optionOrders.ce_strike += MOVE_OTM;
        ce_ltp = ticksCache[currentExpiryOptions[(optionOrders.ce_strike + OTM) + "CE"].instrument_token].last_price;
        if (ce_ltp < minimum_price) {
          optionOrders.ce_strike = false;
          return;
        }
        if (max_sl_count <= 0) {
          optionOrders.ce_strike = false;
          return;
        }
        optionOrders.risk_down_ce = ce_ltp * SL_percent;
        optionOrders.risk_up_ce = ce_ltp * Tgt_percent;
        await pause(5000);
        sendPairOrder('SELL', optionOrders.ce_strike, "CE");
        console.log(optionOrders);
      } else if (ce_ltp < optionOrders.risk_up_ce && ((optionOrders.ce_strike - MOVE_OTM + OTM)) >= atm + OTM) {
        sendPairOrder('BUY', optionOrders.ce_strike, 'CE');
        max_sl_count++;
        optionOrders.ce_strike -= MOVE_OTM;
        ce_ltp = ticksCache[currentExpiryOptions[(optionOrders.ce_strike + OTM) + "CE"].instrument_token].last_price;
        if (ce_ltp < minimum_price) {
          optionOrders.ce_strike = false;
          return;
        }
        optionOrders.risk_down_ce = ce_ltp * SL_percent;
        optionOrders.risk_up_ce = ce_ltp * Tgt_percent;
        await pause(5000);
        sendPairOrder('SELL', optionOrders.ce_strike, "CE");
        console.log(optionOrders);
      }
    }

    if (optionOrders.pe_strike) {
      let pe_ltp = ticksCache[currentExpiryOptions[(optionOrders.pe_strike - OTM) + "PE"].instrument_token];
      if (!pe_ltp) return;
      pe_ltp = pe_ltp.last_price;
      if (pe_ltp > optionOrders.risk_down_pe) {
        max_sl_count--;
        sendPairOrder('BUY', optionOrders.pe_strike, 'PE');
        optionOrders.pe_strike -= MOVE_OTM;
        pe_ltp = ticksCache[currentExpiryOptions[(optionOrders.pe_strike - OTM) + "PE"].instrument_token].last_price;
        if (pe_ltp < minimum_price) {
          optionOrders.pe_strike = false;
          return;
        }
        if (max_sl_count <= 0) {
          optionOrders.pe_strike = false;
          return;
        }
        optionOrders.risk_down_pe = pe_ltp * SL_percent;
        optionOrders.risk_up_pe = pe_ltp * Tgt_percent;
        await pause(5000);
        sendPairOrder('SELL', optionOrders.pe_strike, "PE");
        console.log(optionOrders);
      } else if (pe_ltp < optionOrders.risk_up_pe && (optionOrders.pe_strike + MOVE_OTM - OTM) <= atm - OTM) {
        sendPairOrder('BUY', optionOrders.pe_strike, 'PE');
        max_sl_count++;
        optionOrders.pe_strike += MOVE_OTM;
        pe_ltp = ticksCache[currentExpiryOptions[(optionOrders.pe_strike - OTM) + "PE"].instrument_token].last_price;
        if (pe_ltp < minimum_price) {
          optionOrders.pe_strike = false;
          return;
        }
        optionOrders.risk_down_pe = pe_ltp * SL_percent;
        optionOrders.risk_up_pe = pe_ltp * Tgt_percent;
        await pause(5000);
        sendPairOrder('SELL', optionOrders.pe_strike, "PE");
        console.log(optionOrders);
      }
    }
  }
}

var checkSLQ = async.queue(function (task, callback) {
  onTickCheckStoploss()
    .then(function () {
      callback();
    });
}, 1);

function sendPairOrder(transType = 'SELL', atm = false, tradeType = 'both') {
  let strikes = [
    (atm + OTM) + "CE",
    (atm - OTM) + "PE",
  ];

  for (let i = 0; i < strikes.length; i++) {
    let strike = strikes[i];
    let skip = false;
    if (tradeType === 'CE' && strike.includes('PE')) skip = true;
    if (tradeType === 'PE' && strike.includes('CE')) skip = true;
    if (!skip) {
      sendOrder(strike, transType);
    }
  }
}

async function sendOrder(strike, transType) {
  // PaperTrade.trackOrder(currentExpiryOptions[strike], transType, strategyTag);
  Orderbook.addOrder(currentExpiryOptions[strike], ticksCache[currentExpiryOptions[strike].instrument_token].last_price, transType);
  Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[strike], transType);
}

runStrategy();
