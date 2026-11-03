const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const Papertrade = app.models.PaperTrade;
const optionConfig = require('../tools/optionInstruments');
// const async = require('async');
let eventIdx = 0;
const eventId = () => (eventIdx++);
const moment = require('moment');

// Strategy Config
let channelId = 0;
let strategyTag = 'STG6';

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

let futureToken, currentExpiryOptions = {};
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    setTimeout(() => {
      getPrices();
    }, 5000);
  } catch (err) {
    console.log(err);
  }
}

let ticksCache = {};
let place_new_orders = false;
let check_for_sl = false;
async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);
  if (place_new_orders) takeTrade();
  if (check_for_sl) checkSL();
}

let ce_opt = {}, pe_opt = {};
let triggerPrice = {
  ce: 0,
  pe: 0
};
async function getPrices() {
  let bn_quote = ticksCache[futureToken];

  if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
    let atm_strike = Math.round(bn_quote.last_price / 100) * 100;
    ce_opt = currentExpiryOptions[(atm_strike + 100) + 'CE'];
    pe_opt = currentExpiryOptions[(atm_strike - 100) + 'PE'];

    triggerPrice = {
      ce: ticksCache[ce_opt.instrument_token].last_price * 0.9,
      pe: ticksCache[pe_opt.instrument_token].last_price * 0.9
    };

    place_new_orders = true;
  }
}

let currentPosition = {
  ce: 0,
  pe: 0
};
async function takeTrade() {
  let cltp = {
    ce: ticksCache[ce_opt.instrument_token].last_price,
    pe: ticksCache[pe_opt.instrument_token].last_price
  }
  if (currentPosition.ce === 0 && cltp.ce <= triggerPrice.ce) {
    Papertrade.trackOrder(ce_opt, "SELL", strategyTag, 1);
    currentPosition.ce = 1;
    triggerPrice.ce = cltp.ce;
  }
  if (currentPosition.pe === 0 && cltp.pe <= triggerPrice.pe) {
    Papertrade.trackOrder(pe_opt, "SELL", strategyTag, 1);
    currentPosition.pe = 1;
    triggerPrice.pe = cltp.pe;
  }

  if (currentPosition.ce === 1 && currentPosition.pe === 1) {
    place_new_orders = false;
    stoploss_price = (cltp.ce + cltp.pe) * 1.15;
    check_for_sl = true;
  }
}

let stoploss_price = 0;
async function checkSL() {
  let cltp = {
    ce: ticksCache[ce_opt.instrument_token].last_price,
    pe: ticksCache[pe_opt.instrument_token].last_price
  };

  let current_total = cltp.ce + cltp.pe;

  if (current_total >= stoploss_price) {
    if (cltp.ce >= triggerPrice.ce) {
      Papertrade.trackOrder(ce_opt, "BUY", strategyTag, 1);
      currentPosition.ce = 0;
    }
    if (cltp.pe >= triggerPrice.pe) {
      Papertrade.trackOrder(pe_opt, "BUY", strategyTag, 1);
      currentPosition.pe = 0;
    }
    check_for_sl = false;
  }
}

runStrategy();
// new CronJob('45 15 9 * * 1-5', () => runStrategy(), null, true, 'Asia/Kolkata');
new CronJob('0 58 14 * * 1-5', () => squareOff(), null, true, 'Asia/Kolkata');
