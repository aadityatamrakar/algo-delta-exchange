const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const async = require('async');
const otmSelector = require('../lib/otmSelector');
const moment = require('moment');
const PaperTrade = app.models.PaperTrade;
let eventIdx = 0;
const eventId = () => (eventIdx++);

// Strategy Config
let channelId = 0;
let strategyTag = 'Cheetah_0042',
  trail_sl = 30,
  max_sl_times = 3;

async function executeSL(orderId, token, price) {
  try {
    let trade = await PaperTrade.findOne({
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
PaperTrade.getDataSource().connector.connect(function (err, db) {
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
                let stopPrice = parseFloat((parseFloat(update.price) + trail_sl).toFixed(1));
                let newEventId = eventId();
                eventTrigger[newEventId] = {
                  atm: eventTrigger[eventTrgIdx].atm,
                  strike: eventTrigger[eventTrgIdx].strike,
                  type: eventTrigger[eventTrgIdx].type,
                  action: 'remove_position'
                };
                PaperTrade.trackOrder_slm(currentExpiryOptions[eventTrigger[eventTrgIdx].strike + eventTrigger[eventTrgIdx].type], 'BUY', strategyTag, 1, stopPrice, [newEventId]);
                eventTrigger[eventTrgIdx] = false;
              }
            } else if (eventTrigger[eventTrgIdx] && eventTrigger[eventTrgIdx].action == 'remove_position') {
              try {
                // if (max_sl_times > 0) {
                //   max_sl_times -= 1;
                //   let bn_quote = ticksCache[futureToken];
                //   let new_ATM_Strike = (Math.round(bn_quote.last_price / 100) * 100);
                //   let typeBuy = eventTrigger[eventTrgIdx].type == 'PE' ? 'CE' : 'PE';
                //   sendOrder(new_ATM_Strike, typeBuy);
                // }

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
  fromDate, toDate, farOtm;
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

    setTimeout(placeTrade, 10000);
    // new CronJob('0 17 9 * * 1-5', placeTrade, null, true, 'Asia/Kolkata');
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
  let ce_sl_m = eventId();
  eventTrigger[ce_sl_m] = {
    atm: new_ATM_Strike,
    strike: ce_option.strike,
    type: typeBuy,
    instrument_token: ce_option.instrument_token,
    sl_trigger: ce_ltp + trail_sl,
    action: 'place_sl'
  };
  PaperTrade.trackOrder_v2(ce_option, 'SELL', strategyTag, 1, [ce_sl_m]);
}

runStrategy();
