const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;
const optionConfig = require('../tools/optionInstruments');
const async = require('async');
const moment = require('moment');
let eventIdx = 0;
const eventId = () => (eventIdx++);

// Strategy Config
let channelId = 0;
let strategyTag = 'STGL-Mid-0020-3';

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
            if (eventTrigger[eventTrgIdx] && eventTrigger[eventTrgIdx].action == 'remove_position') {
              try {
                executeSL(eventTrgIdx, eventTrigger[eventTrgIdx].instrument_token, update.price);
                position_open[eventTrigger[eventTrgIdx].type] = false;
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
  ce_strike = false,
  pe_strike = false;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    if (moment().day() == 3) {
      currentExpiryOptions = optionData.nextWeekInstruments;
    }
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    setTimeout(function () {
      takeTrade();
    }, 5000);
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

  checkReEntryQ.push({
    check: 1
  });

  // checkSLQ.push({
  //   check: 1
  // });
}

let sl_percent = 1.25,
  tradeStartPrice,
  lastPrice, position_open = {
    CE: false,
    PE: false
  },
  checkFlag = false;
async function takeTrade(type = 'both') {
  let bn_quote = ticksCache[futureToken];

  if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
    tradeStartPrice = bn_quote.last_price;
    lastPrice = bn_quote.last_price;
    let optionsStrikes = Object.values(currentExpiryOptions).map(c => {
      if (ticksCache[c.instrument_token] && ticksCache[c.instrument_token].last_price) {
        c.distance = Math.abs(ticksCache[c.instrument_token].last_price - 250);
      } else c.distance = 250;
      return c;
    }).sort((a, b) => {
      return (a.distance - b.distance);
    });

    ce_strike = false, pe_strike = false;
    for (i = 0; i < optionsStrikes.length; i++) {
      if (!ce_strike && optionsStrikes[i].instrument_type == 'CE') ce_strike = optionsStrikes[i].strike;
      if (!pe_strike && optionsStrikes[i].instrument_type == 'PE') pe_strike = optionsStrikes[i].strike;

      if (ce_strike && pe_strike) break;
    }

    position_open = {
      CE: true,
      PE: true
    };
    sendOrder(ce_strike, 'CE');
    sendOrder(pe_strike, 'PE');
    checkFlag = true;
  }
}

let optionOrders = [];
async function sendOrder(new_ATM_Strike, typeBuy) {
  // console.log(new_ATM_Strike + typeBuy);
  let tradeStrike = parseInt(new_ATM_Strike);

  let ce_option = currentExpiryOptions[tradeStrike + typeBuy];
  let ce_ltp = ticksCache[ce_option.instrument_token].last_price;
  let sl_id = eventId();
  let sl_trigger = Math.round(ce_ltp * sl_percent * 10) / 10;
  await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, ce_option, 'SELL');
  optionOrders.push({
    atm: new_ATM_Strike,
    strike: tradeStrike,
    type: typeBuy,
    instrument_token: ce_option.instrument_token,
    entry: ce_ltp,
    sl_trigger: sl_trigger,
    sl_id: sl_id,
    sl_hit: false
  });

  eventTrigger[sl_id] = {
    instrument_token: ce_option.instrument_token,
    strike: tradeStrike,
    type: typeBuy,
    action: 'remove_position'
  };
  PaperTrade.trackOrder_slm(currentExpiryOptions[tradeStrike + typeBuy], 'BUY', strategyTag, 1, sl_trigger, [sl_id]);
}

// async function checkSL() {
//   optionOrders.forEach(async (ce_position, idx) => {
//     let check_option = ce_position;
//     if (ticksCache[check_option.instrument_token].last_price > ce_position.sl_trigger) {
//       delete optionOrders[idx];
//       executeSL(check_option.sl_id, check_option.instrument_token, ticksCache[check_option.instrument_token].last_price);
//       position_open[check_option.type] = false;
//       return false;
//     } else return true;
//   });
// }

// var checkSLQ = async.queue(function (task, callback) {
//   checkSL().then(function (res) {
//     callback();
//   });
// }, 1);

async function checkReEntry() {
  let futurePrice = ticksCache[futureToken].last_price;
  if (tradeStartPrice >= futurePrice && tradeStartPrice <= lastPrice) {
    if (!position_open.CE) {
      position_open.CE = true;
      sendOrder(ce_strike, 'CE');
    }
    if (!position_open.PE) {
      position_open.PE = true;
      sendOrder(pe_strike, 'PE');
    }
  } else if (tradeStartPrice <= futurePrice && tradeStartPrice >= lastPrice) {
    if (!position_open.CE) {
      position_open.CE = true;
      sendOrder(ce_strike, 'CE');
    }
    if (!position_open.PE) {
      position_open.PE = true;
      sendOrder(pe_strike, 'PE');
    }
  }
  lastPrice = futurePrice;
}

var checkReEntryQ = async.queue(function (task, callback) {
  if (checkFlag) {
    checkReEntry().then(function (res) {
      callback();
    });
  } else callback();
}, 1);


runStrategy();
