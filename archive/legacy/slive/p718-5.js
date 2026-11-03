const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const XtsAccount = app.models.xtsAccount;
const Manager = app.models.manager;
const Papertrade = app.models.PaperTrade;
const optionConfig = require('../tools/optionInstruments');
// const async = require('async');
let eventIdx = 0;
const eventId = () => (eventIdx++);
const moment = require('moment');

// Strategy Config
let channelId = 0;
let strategyTag = 'P718-5';

async function executeSL(orderId, token, price) {
  try {
    let trade = await Papertrade.findOne({
      where: {
        tag: strategyTag,
        dataObj: [parseInt(orderId)],
        instrument_token: token
      }
    });
    console.log(trade);
    if (trade) {
      trade.status = 'COMPLETE';
      trade.order_type = 'MARKET';
      trade.order_timestamp = new Date(moment().toDate());
      trade.average_price = parseFloat(price);
      await trade.save();
    }
  } catch (err) {
    console.log(err);
  }
}
// When order complete -> Put SLM Order
// When SLM Trigger -> Update atm rule
let eventTrigger = {};
Papertrade.getDataSource().connector.connect(function (err, db) {
  console.log('datasource connected');
  const collection2 = db.collection("OrderUpdate");
  const changeStream2 = collection2.watch();
  changeStream2.on("change", function (event) {
    try {
      if (event.operationType == 'insert') {
        console.log(event, eventTrigger);
        let update = event.fullDocument;
        if (update.updateType == 'order' && update.strategy == strategyTag) {
          if (update.params && update.params.length > 0) {
            let eventTrgIdx = update.params[0];
            if (eventTrigger[eventTrgIdx] && eventTrigger[eventTrgIdx].action == 'place_sl') {
              if (update.status == 'Filled') {
                let stopPrice = parseFloat((parseFloat(update.price) * eventTrigger[eventTrgIdx].sl_trigger).toFixed(1));
                let newEventId = eventId();
                let slInstrument = currentExpiryOptions[eventTrigger[eventTrgIdx].strike + eventTrigger[eventTrgIdx].type];
                eventTrigger[newEventId] = {
                  atm: eventTrigger[eventTrgIdx].atm,
                  strike: eventTrigger[eventTrgIdx].strike,
                  type: eventTrigger[eventTrgIdx].type,
                  instrument_token: slInstrument.instrument_token,
                  action: 'remove_position'
                };
                Papertrade.trackOrder_slm(slInstrument, 'BUY', strategyTag, 1, stopPrice, [newEventId]);
                eventTrigger[eventTrgIdx] = false;
              }
            } else if (eventTrigger[eventTrgIdx] && eventTrigger[eventTrgIdx].action == 'remove_position') {
              try {
                executeSL(eventTrgIdx, eventTrigger[eventTrgIdx].instrument_token, update.price);
                eventTrigger[eventTrgIdx] = false;
              } catch (err) {
                console.log(err);
              }
            }
          }
        }
      }
    } catch (err) {
      console.log(err);
      notify('Error: OrderUpdate: ' + strategyTag);
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

    if (moment().day() == 1) {
      // monday
      new CronJob('58 16 9 * * 1', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
      new CronJob('58 6 10 * * 1', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
      new CronJob('58 1 11 * * 1', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
      new CronJob('58 11 12 * * 1', () => takeTrade(1.5), null, true, 'Asia/Kolkata');
    } else if (moment().day() == 2) {
      // tuesday
      new CronJob('58 16 9 * * 2', () => takeTrade(1.7), null, true, 'Asia/Kolkata');
      new CronJob('58 11 10 * * 2', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
      new CronJob('58 1 11 * * 2', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
      new CronJob('58 1 12 * * 2', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
    } else if (moment().day() == 3) {
      // wednesday
      new CronJob('58 16 9 * * 3', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
      new CronJob('58 1 10 * * 3', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
      new CronJob('58 1 11 * * 3', () => takeTrade(1.4), null, true, 'Asia/Kolkata');
      new CronJob('58 11 12 * * 3', () => takeTrade(1.6), null, true, 'Asia/Kolkata');
    } else if (moment().day() == 4) {
      // thursday
      new CronJob('58 16 9 * * 4', () => takeTrade(1.9, true), null, true, 'Asia/Kolkata');
      new CronJob('58 1 10 * * 4', () => takeTrade(1.3, true), null, true, 'Asia/Kolkata');
      new CronJob('58 1 11 * * 4', () => takeTrade(2, true), null, true, 'Asia/Kolkata');
      new CronJob('58 06 12 * * 4', () => takeTrade(1.8, true), null, true, 'Asia/Kolkata');
    } else if (moment().day() == 5) {
      // friday
      new CronJob('58 21 9 * * 5', () => takeTrade(1.7), null, true, 'Asia/Kolkata');
      new CronJob('58 06 11 * * 5', () => takeTrade(1.6), null, true, 'Asia/Kolkata');
      new CronJob('58 06 12 * * 5', () => takeTrade(1.2), null, true, 'Asia/Kolkata');
      new CronJob('58 1 13 * * 5', () => takeTrade(1.6), null, true, 'Asia/Kolkata');
    }
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
  checkSL();
}

// let SL_percent = 1.3;
async function takeTrade(SL_percent, hedge = false) {
  let bn_quote = ticksCache[futureToken];

  if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
    let atm_strike = Math.round(bn_quote.last_price / 100) * 100;
    let CE_opt = currentExpiryOptions[atm_strike + 'CE'];
    let PE_opt = currentExpiryOptions[atm_strike + 'PE'];

    optionData = await optionConfig.download();
    if (optionData && optionData.max_pain) {
      max_pain = optionData.max_pain;
    }
    let sellOptionType = max_pain < bn_quote.last_price ? 'PE' : 'CE';

    if (sellOptionType == 'CE') {
      place_single_order(atm_strike, sellOptionType, CE_opt, SL_percent);
    } else {
      place_single_order(atm_strike, sellOptionType, PE_opt, SL_percent);
    }
  }
}

let max_pain = 0;
async function place_single_order(atm_strike, opt_type, opt, SL_percent, qty = 1) {
  let ce_sl_m = eventId();
  eventTrigger[ce_sl_m] = {
    atm: atm_strike,
    strike: opt.strike,
    type: opt_type,
    instrument_token: opt.instrument_token,
    sl_trigger: SL_percent,
    sl_hit: false,
    action: 'place_sl'
  };
  // Papertrade.trackOrder_v2(opt, 'SELL', strategyTag, qty, [ce_sl_m]);
  Papertrade.trackOrder(opt, 'SELL', strategyTag);
  optionOrders.push(eventTrigger[ce_sl_m]);
}

async function checkSL() {
  optionOrders.forEach(async (ce_position, idx) => {
    let check_option = ce_position;
    if (ticksCache[check_option.instrument_token].last_price > check_option.sl_trigger) {
      delete optionOrders[idx];
      Papertrade.trackOrder(currentExpiryOptions[check_option.strike + check_option.type], 'BUY', strategyTag);
      return false;
    } else return true;
  });
}

function squareOff() {
  Papertrade.squareoff(strategyTag, function (err, resp) {
    if (err) {
      console.log(err);
    } else {
      console.log(resp);
    }
  });

  // XtsAccount.removePending({
  //   accountId: '6180b8bf540ac40f3b38b863',
  //   strategy: strategyTag
  // });

  // Manager.stop({
  //   name: 'p718-5'
  // });
}

// runStrategy();
new CronJob('0 15 9 * * 1-5', () => runStrategy(), null, true, 'Asia/Kolkata');
new CronJob('0 58 14 * * 1-5', () => squareOff(), null, true, 'Asia/Kolkata');
