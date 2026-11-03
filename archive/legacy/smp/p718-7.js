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
let strategyTag = 'P718-7';

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
let place_new_orders = false;
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
      place_new_orders = true;
    }, 15000);
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
  if (place_new_orders) takeTrade();
}

let strikePositions = {};
let strikes = [];
async function takeTrade() {
  let bn_quote = ticksCache[futureToken];
  let atm_strike = Math.round(bn_quote.last_price / 100) * 100;
  if (!strikePositions[atm_strike]) {
    let ce_opt = currentExpiryOptions[(atm_strike + 100) + 'CE'];
    let pe_opt = currentExpiryOptions[(atm_strike - 100) + 'PE'];

    strikePositions[atm_strike] = {
      ce_opt: ce_opt,
      pe_opt: pe_opt,
      ce_token: ce_opt.instrument_token,
      pe_token: pe_opt.instrument_token,
      trigger: {
        ce: ticksCache[ce_opt.instrument_token].last_price * 0.9,
        pe: ticksCache[pe_opt.instrument_token].last_price * 0.9
      },
      entry: { ce: false, pe: false },
      positionOpen: { ce: false, pe: false },
      stoploss: false,
    };
    strikes.push(atm_strike);
  }

  checkTrigger(atm_strike);
  for (let i = 0; i < strikes.length; i++) {
    checkSL(parseInt(strikes[i]));
  }
}

async function checkTrigger(atm) {
  let ce_price = ticksCache[strikePositions[atm].ce_token].last_price;
  let pe_price = ticksCache[strikePositions[atm].pe_token].last_price;

  if (strikePositions[atm].entry.ce === false && ce_price <= strikePositions[atm].trigger.ce) {
    Papertrade.trackOrder(strikePositions[atm].ce_opt, "SELL", strategyTag, 1);
    strikePositions[atm].entry.ce = ce_price;
  }
  if (strikePositions[atm].entry.pe === false && pe_price <= strikePositions[atm].trigger.pe) {
    Papertrade.trackOrder(strikePositions[atm].pe_opt, "SELL", strategyTag, 1);
    strikePositions[atm].entry.pe = pe_price;
  }

  if (strikePositions[atm].entry.pe !== false && strikePositions[atm].entry.ce !== false && strikePositions[atm].stoploss === false) {
    strikePositions[atm].stoploss = (strikePositions[atm].entry.ce + strikePositions[atm].entry.pe) * 1.1;
  }
}

async function checkSL(atm) {
  if (strikePositions[atm].stoploss) {
    let cltp = {
      ce: ticksCache[strikePositions[atm].ce_token].last_price,
      pe: ticksCache[strikePositions[atm].pe_token].last_price
    };

    let current_total = cltp.ce + cltp.pe;

    if (current_total >= strikePositions[atm].stoploss) {
      if (cltp.ce >= strikePositions[atm].entry.ce) {
        Papertrade.trackOrder(strikePositions[atm].ce_opt, "BUY", strategyTag, 1);
        strikePositions[atm].entry.ce = false;
      }
      if (cltp.pe >= strikePositions[atm].entry.pe) {
        Papertrade.trackOrder(strikePositions[atm].pe_opt, "BUY", strategyTag, 1);
        strikePositions[atm].entry.pe = false;
      }
    }
    strikePositions[atm].stoploss = false;
  }
}

// runStrategy();
new CronJob('45 15 9 * * 1-5', () => runStrategy(), null, true, 'Asia/Kolkata');
new CronJob('50 23 15 * * 1-5', () => squareOff(), null, true, 'Asia/Kolkata');
