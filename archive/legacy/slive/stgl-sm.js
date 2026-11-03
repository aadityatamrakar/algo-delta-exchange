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
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const counter = () => (counter.count = (counter.count || 0) + 1);
// Strategy Config
let channelId = 0;
let strategyTag = 'STGL-M25';

async function executeSL(orderId, token, price) {
  try {
    let trade = await PaperTrade.findOne({
      where: {
        tag: strategyTag,
        dataObj: [orderId],
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
                let stopPrice = parseFloat((parseFloat(update.price) * sl_percent).toFixed(1));
                let newEventId = counter();
                let slInstrument = currentExpiryOptions[eventTrigger[eventTrgIdx].strike + eventTrigger[eventTrgIdx].type];
                eventTrigger[newEventId] = {
                  atm: eventTrigger[eventTrgIdx].atm,
                  strike: eventTrigger[eventTrgIdx].strike,
                  type: eventTrigger[eventTrgIdx].type,
                  instrument_token: slInstrument.instrument_token,
                  action: 'remove_position'
                };
                PaperTrade.trackOrder_slm(slInstrument, 'BUY', strategyTag, 1, stopPrice, [newEventId]);
                eventTrigger[eventTrgIdx] = false;
              }
            } else if (eventTrigger[eventTrgIdx] && eventTrigger[eventTrgIdx].action == 'remove_position') {
              try {
                positionsOpen["S" + eventTrigger[eventTrgIdx].atm][eventTrigger[eventTrgIdx].type] -= 1;
                console.log(positionsOpen);
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
  fromDate, toDate;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    if (moment().day() == 3) {
      currentExpiryOptions = optionData.nextWeekInstruments;
    }
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    // await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    setTimeout(async function () {
      lastQuote = ticksCache[futureToken].last_price;

      await sleep(5000);

      startTrade = true;
      for (let i = 0; i < 2; i++) {
        placeTrade(true, 100);
        await sleep(1000);
        placeTrade(true, 200);
        await sleep(1000);
        // placeTrade(true, 300);
        // await sleep(1000);
        // placeTrade(true, 400);
        // await sleep(1000);
      }

    }, 5000);
  } catch (err) {
    console.log('main err', err);
  }
}

let optionOrders = [],
  ATM_Strike = [],
  positionsOpen = [],
  sl_percent = 1.25;

let ticksCache = {},
  startTrade = false;
async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);
}

let lastQuote;
async function placeTrade(forceTrade = false, atm_distance = 0) {
  let bn_quote = ticksCache[futureToken];
  let new_ATM_Strike = (Math.round(bn_quote.last_price / 100) * 100);

  let ce_option = currentExpiryOptions[(new_ATM_Strike + atm_distance) + "CE"];
  let pe_option = currentExpiryOptions[(new_ATM_Strike - atm_distance) + "PE"];

  let ce_ltp = ticksCache[ce_option.instrument_token].last_price;
  let ce_sl_m = counter();
  eventTrigger[ce_sl_m] = {
    atm: new_ATM_Strike,
    strike: ce_option.strike,
    type: "CE",
    instrument_token: ce_option.instrument_token,
    sl_trigger: ce_ltp * sl_percent,
    sl_hit: false,
    action: 'place_sl'
  };
  let pe_ltp = ticksCache[pe_option.instrument_token].last_price;
  let pe_sl_m = counter();
  eventTrigger[pe_sl_m] = {
    atm: new_ATM_Strike,
    strike: pe_option.strike,
    type: "PE",
    instrument_token: pe_option.instrument_token,
    sl_trigger: pe_ltp * sl_percent,
    action: 'place_sl'
  };

  PaperTrade.trackOrder_v2(ce_option, 'SELL', strategyTag, 1, [ce_sl_m]);
  PaperTrade.trackOrder_v2(pe_option, 'SELL', strategyTag, 1, [pe_sl_m]);
}

runStrategy();
