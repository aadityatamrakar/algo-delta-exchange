const CronJob = require("cron").CronJob;
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const Account = app.models.account;
const Positional = app.models.positional;
const kiteTicker = require('../lib/KiteTicker');
const futureConfig = require('../tools/futureInstruments');
const async = require('async');
const moment = require('moment');
const StrategyData = app.models.strategyData;
const strategyId = "60efb6764cfc397e3fbc6ea2";

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
    // console.log('subscribing', subs);
    liveFeed.subscribe(subs);
    liveFeed.setMode(liveFeed.modeFull, subs);
  });
}

let futuresToken, t_hdfc, t_hdfc_bank;

let strategyConfig = {
  spreadsTriggered: [],
  optionOrders: [],
  triggerAt: 1000
};
async function init() {
  futuresToken = await futureConfig();
  strategyConfig = await StrategyData.findById(strategyId);
  console.log(strategyConfig);

  let masterId = app.get('masterId');
  let base_acc = await Account.findById(masterId);
  zapi = await zerodha_init(base_acc);

  t_hdfc = futuresToken['HDFC'].instrument_token;
  t_hdfc_bank = futuresToken['HDFCBANK'].instrument_token;
  setTimeout(function () {
    ticker([t_hdfc, t_hdfc_bank]);
  }, 10000);
}

async function saveStrategyData() {
  try {
    let res = await StrategyData.replaceById(strategyId, {
      title: strategyConfig.title,
      spreadsTriggered: strategyConfig.spreadsTriggered,
      optionOrders: strategyConfig.optionOrders,
      triggerAt: strategyConfig.triggerAt,
    });
    console.log(res);
  } catch (err) {
    console.log(err);
  }
}

let ticksCache = {};

async function checkTicks(ticks) {
  ticks = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});

  Object.assign(ticksCache, ticks);
  checkSLQ.push(1);
  calcSpread();
}

let triggerAt = 10,
  hdfc_lot = 2,
  hdfcbank_lot = 2,
  lastTick;
async function calcSpread() {
  let entry = _SP_bid(t_hdfc_bank) * 2 - _SP_ask(t_hdfc);
  let exit = _SP_ask(t_hdfc_bank) * 2 - _SP_bid(t_hdfc);

  if (lastTick) {
    strategyConfig.triggerAt = Math.round(entry / triggerAt) * triggerAt;
  }

  if (strategyConfig.spreadsTriggered.indexOf(strategyConfig.triggerAt) == -1 && entry >= strategyConfig.triggerAt) {
    Positional.trackOrder(futuresToken['HDFC'], 'BUY', 'HDFC_SPD', hdfc_lot);
    Positional.trackOrder(futuresToken['HDFCBANK'], 'SELL', 'HDFC_SPD', hdfcbank_lot);
    strategyConfig.spreadsTriggered.push(strategyConfig.triggerAt);
    strategyConfig.optionOrders.push({
      entry: entry,
      trigger: strategyConfig.triggerAt,
      target: entry - triggerAt
    });
    console.log('ENTRY: ' + entry);
    saveStrategyData();
  }
  console.log(strategyConfig.triggerAt, roundOff(entry), roundOff(exit));
  lastTick = entry;
}

async function checkSL() {
  strategyConfig.optionOrders.forEach(async (position, idx) => {
    let exit = _SP_ask(t_hdfc_bank) * 2 - _SP_bid(t_hdfc);

    if (exit < position.target) {
      let spdIdx = strategyConfig.spreadsTriggered.indexOf(position.trigger);
      if (spdIdx != -1) strategyConfig.spreadsTriggered.splice(spdIdx, 1);
      strategyConfig.optionOrders.splice(idx, 1);
      Positional.trackOrder(futuresToken['HDFCBANK'], 'BUY', 'HDFC_SPD', hdfcbank_lot);
      Positional.trackOrder(futuresToken['HDFC'], 'SELL', 'HDFC_SPD', hdfc_lot);
      saveStrategyData();
      return false;
    } else return true;
  });
}

var checkSLQ = async.queue(function (task, callback) {
  checkSL().then(function (res) {
    callback();
  });
}, 1);

let roundOff = (price) => (Math.round(price * 100) / 100);
let _SP_bid = (token) => (ticksCache[token].depth.buy[0].price);
let _SP_ask = (token) => (ticksCache[token].depth.sell[0].price);

// init();
new CronJob('0 16 9 * * 1-5', init, null, true, 'Asia/Kolkata');
new CronJob('0 26 15 * * 1-5', function () {
  process.exit();
}, null, true, 'Asia/Kolkata');
