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
let strategyTag = 'PE_D_2';
let option_type = 'PE',
  pending_qty = 80,
  per_trade_qty = 15,
  profit = 8,
  per_trade_jump = 0.25,
  ratio = 2;

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

let futureToken, currentExpiryOptions = {},
  day_config = [];
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    if (moment().day() == 3) {
      currentExpiryOptions = optionData.nextWeekInstruments;
    }
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    day_config = otmSelector('SD_2');
    current_spread = day_config[5];
    
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);
  } catch (err) {
    console.log('main err', err);
  }
}

let optionOrders = [];

let ticksCache = {};
async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);

  takePositionQ.push({
    check: 1
  });
  checkSLQ.push({
    check: 1
  });
}
let spreadAvailable = {
    CE: [],
    PE: []
  },
  currentATM, lastATM, current_spread;
async function placeTrade() {
  currentATM = Math.round(_TP(futureToken) / 100) * 100;
  if (currentATM !== lastATM) {
    lastATM = currentATM;
    spreadAvailable['CE'] = [];
    spreadAvailable['PE'] = [];
    for (i = day_config[0]; i < day_config[0] + day_config[1]; i++) {
      let strike_1_ce = currentATM + (i * 100);
      let strike_1_pe = currentATM - (i * 100);
      for (j = i + day_config[2]; j < day_config[3]; j++) {
        if (i == j) continue;
        let strike_2_ce = currentATM + (j * 100);
        let strike_2_pe = currentATM - (j * 100);
        spreadAvailable.CE.push([strike_1_ce, strike_2_ce]);
        spreadAvailable.PE.push([strike_1_pe, strike_2_pe]);
      }
    }
    console.log(spreadAvailable[option_type]);
  }

  let filtered = [];
  let ratiosAvailable = [ratio];
  async.each(spreadAvailable[option_type], function (spreadStrikes, cb) {
    async.each(ratiosAvailable, function (spreadRatio, cb2) {
      let strike_1 = _SP_ask(spreadStrikes[0] + option_type);
      let strike_2 = _SP_bid(spreadStrikes[1] + option_type) * spreadRatio;

      let spread_diff = strike_2 - strike_1;
      let gap = Math.abs(spreadStrikes[0] - spreadStrikes[1]);
      let distance = Math.abs(spreadStrikes[0] - currentATM);

      if (spread_diff < day_config[4] && spread_diff > day_config[5] && spread_diff > current_spread) {
        filtered.push([spreadStrikes[0] + option_type, spreadStrikes[1] + option_type, spreadRatio, strike_1, _SP_bid(spreadStrikes[1] + option_type), spread_diff, distance, gap]);
      }
      cb2();
    }, cb);
  }, function () {
    filtered = filtered.sort((a, b) => {
      return (b[6] + b[7]) - (a[6] + b[7]);
    }).reverse();
    if (filtered.length > 0) {
      console.log(filtered, current_spread, pending_qty);
      if (pending_qty > 0 && pending_qty >= per_trade_qty) {
        pending_qty -= per_trade_qty;
        PaperTrade.trackOrder(currentExpiryOptions[filtered[0][0]], "BUY", strategyTag, per_trade_qty);
        PaperTrade.trackOrder(currentExpiryOptions[filtered[0][1]], "SELL", strategyTag, per_trade_qty * ratio);
        if (current_spread === day_config[5]) current_spread = filtered[0][5] + per_trade_jump;
        else current_spread += per_trade_jump;
        day_config[4] = 0;
        optionOrders.push({
          strike_1: filtered[0][0],
          strike_2: filtered[0][1],
          entry: filtered[0][5],
          target: filtered[0][5] - profit
        });
      }
    }
  });
}

async function checkSL() {
  optionOrders.forEach(async (spreadElm, idx) => {
    let spread = spreadElm;
    let strike_1 = _SP_bid(spread.strike_1);
    let strike_2 = _SP_ask(spread.strike_2) * ratio;
    let spread_diff = strike_2 - strike_1;
    if (spread_diff < spread.target) {
      delete optionOrders[idx];
      PaperTrade.trackOrder(currentExpiryOptions[spread.strike_2], "BUY", strategyTag, per_trade_qty * ratio);
      PaperTrade.trackOrder(currentExpiryOptions[spread.strike_1], "SELL", strategyTag, per_trade_qty);
      pending_qty += per_trade_qty;
    }
  });
  return true;
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

const _TP = (token) => (ticksCache[token].last_price);
const _SP = (strike) => (Math.round(((ticksCache[currentExpiryOptions[strike].instrument_token].depth.buy[0].price + ticksCache[currentExpiryOptions[strike].instrument_token].depth.sell[0].price) / 2) * 100) / 100);
const _SP_bid = (strike) => (ticksCache[currentExpiryOptions[strike].instrument_token].depth.buy[0].price);
const _SP_ask = (strike) => (ticksCache[currentExpiryOptions[strike].instrument_token].depth.sell[0].price);

// runStrategy();
new CronJob('0 30 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('40 23 15 * * 1-5', async function () {
  setTimeout(function () {
    process.exit();
  }, 15000);
}, null, true, 'Asia/Kolkata');
