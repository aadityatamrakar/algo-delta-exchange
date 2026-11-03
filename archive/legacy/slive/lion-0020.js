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
let eventIdx = 0;
const eventId = () => (eventIdx++);

// Strategy Config
let channelId = 0;
// LION_S_25
let strategyTag = 'Lion_0020',
  sl_percent = 1.25;

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
                let newEventId = eventId();
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

let futureToken, currentExpiryOptions = {},
  fromDate, toDate;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    farOtm = otmSelector();
    // await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    setTimeout(function () {
      lastQuote = ticksCache[futureToken].last_price;
      setTimeout(function () {
        startTrade = true;
        placeTrade(true);
      }, 5000);
    }, 10000);
  } catch (err) {
    console.log('main err', err);
  }
}

let optionOrders = [],
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

  if (startTrade) {
    takePositionQ.push({
      check: 1
    });
  }
}

let farOtm = 400,
  lastQuote;
async function placeTrade(forceTrade = false) {
  let bn_quote = ticksCache[futureToken];
  let new_ATM_Strike = (Math.round(bn_quote.last_price / 100) * 100);
  let isCrossover = forceTrade;
  if (bn_quote.last_price >= new_ATM_Strike && lastQuote <= new_ATM_Strike) {
    isCrossover = true;
  } else if (bn_quote.last_price <= new_ATM_Strike && lastQuote >= new_ATM_Strike) {
    isCrossover = true;
  }
  lastQuote = bn_quote.last_price;

  if (isCrossover) {
    let ce_option = currentExpiryOptions[(new_ATM_Strike + farOtm) + "CE"];
    let pe_option = currentExpiryOptions[(new_ATM_Strike - farOtm) + "PE"];

    let takePosition = false;

    if (positionsOpen["S" + new_ATM_Strike]) {
      // let totalOpen = positionsOpen["S" + new_ATM_Strike].CE + positionsOpen["S" + new_ATM_Strike].PE;
      // console.log(positionsOpen["S" + new_ATM_Strike].CE, positionsOpen["S" + new_ATM_Strike].PE);
      if (positionsOpen["S" + new_ATM_Strike].CE == 0) takePosition = true;
      if (positionsOpen["S" + new_ATM_Strike].PE == 0) takePosition = true;
    } else takePosition = true;

    if (takePosition) {
      // console.log(new_ATM_Strike);
      ATM_Strike.push("S" + new_ATM_Strike);

      let ce_ltp = ticksCache[ce_option.instrument_token].last_price;
      let ce_sl_m = eventId();
      eventTrigger[ce_sl_m] = {
        atm: new_ATM_Strike,
        strike: ce_option.strike,
        type: "CE",
        instrument_token: ce_option.instrument_token,
        sl_trigger: ce_ltp * sl_percent,
        sl_hit: false,
        action: 'place_sl'
      };
      PaperTrade.trackOrder_v2(ce_option, 'SELL', strategyTag, 1, [ce_sl_m]);

      let pe_ltp = ticksCache[pe_option.instrument_token].last_price;
      let pe_sl_m = eventId();
      eventTrigger[pe_sl_m] = {
        atm: new_ATM_Strike,
        strike: pe_option.strike,
        type: "PE",
        instrument_token: pe_option.instrument_token,
        sl_trigger: pe_ltp * sl_percent,
        action: 'place_sl'
      };
      PaperTrade.trackOrder_v2(pe_option, 'SELL', strategyTag, 1, [pe_sl_m]);

      if (positionsOpen["S" + new_ATM_Strike]) {
        positionsOpen["S" + new_ATM_Strike].CE += 1;
        positionsOpen["S" + new_ATM_Strike].PE += 1;
      } else {
        positionsOpen["S" + new_ATM_Strike] = {
          CE: 1,
          PE: 1
        };
      }
      console.log(positionsOpen);
      return true;
    } else return false;
  }
}

var takePositionQ = async.queue(function (task, callback) {
  placeTrade().then(function (res) {
    callback();
  });
}, 1);

runStrategy();
