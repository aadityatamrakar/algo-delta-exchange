const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker.js');
const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;
const XtsAccount = app.models.xtsAccount;
const optionConfig = require('../tools/optionInstruments.js');
const moment = require('moment');
let eventIdx = 0;
const eventId = () => (eventIdx++);

// Strategy Config
let channelId = 0;
let strategyTag = 'FUTURE-100',
  sl_points = 50, // 50 points stop loss
  target_points = 100; // 100 points target

let multiplier = 2; // Quantity multiplier for SL/Target orders

// Event tracking for order management
let eventTrigger = {};

async function executeSL(orderId, token, price) {
  try {
    let trade = await PaperTrade.findOne({
      where: {
        tag: strategyTag,
        dataObj: [parseInt(orderId)],
        instrument_token: token
      }
    });
    console.log('Executing SL/Target:', trade);
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

async function cancelPendingOrder() {
  try {
    XtsAccount.removePending("65f7c2f15401da14d2bc7bbe", strategyTag, function (err, res) {
      if (err) {
        console.log('Error removing pending order:', err);
      } else {
        console.log('Pending order removed:', res);
      }
    })
  } catch (err) {
    console.log(err);
  }
}

// Event tracking for order management
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
            // Handle main order execution - place SL and Target
            if (eventTrigger[eventTrgIdx] && eventTrigger[eventTrgIdx].action == 'place_sl_target') {
              if (update.status == 'Filled') {
                let orderPrice = parseInt(update.price.replace(/,/g, ''));
                let side = eventTrigger[eventTrgIdx].side;
                placeTargetStoploss(side, orderPrice);
                eventTrigger[eventTrgIdx] = false;
              }
            }
            // Handle SL hit - cancel target and reverse
            else if (eventTrigger[eventTrgIdx] && eventTrigger[eventTrgIdx].action == 'sl_hit') {
              if (update.status == 'Filled') {
                // Cancel opposite order
                let oppositeId = eventTrigger[eventTrgIdx].oppositeOrderId;
                let side = eventTrigger[eventTrgIdx].side;
                cancelPendingOrder();

                setTimeout(function () {
                  let orderPrice = parseInt(update.price.replace(/,/g, ''));
                  placeTargetStoploss(side, orderPrice);
                }, 3000);

                executeSL(eventTrgIdx, eventTrigger[eventTrgIdx].instrument_token, update.price);
                eventTrigger[eventTrgIdx] = false;
                eventTrigger[oppositeId] = false;
              }
            }
            // Handle Target hit - cancel SL and reverse
            else if (eventTrigger[eventTrgIdx] && eventTrigger[eventTrgIdx].action == 'target_hit') {
              if (update.status == 'Filled') {
                // Cancel opposite order
                let oppositeId = eventTrigger[eventTrgIdx].oppositeOrderId;
                let side = eventTrigger[eventTrgIdx].side;
                cancelPendingOrder();

                setTimeout(function () {
                  let orderPrice = parseInt(update.price.replace(/,/g, ''));
                  placeTargetStoploss(side, orderPrice);
                }, 3000);

                executeSL(eventTrgIdx, eventTrigger[eventTrgIdx].instrument_token, update.price);
                eventTrigger[eventTrgIdx] = false;
                eventTrigger[oppositeId] = false;
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
});

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

let futureToken, currentFuture = {}, currentPrice = 0;
let position = false; // Track if we have an active position
let isFirstTrade = true; // Track if this is the first trade
let triggerLevel = 15; // Points movement required to trigger trade

async function runStrategy() {
  try {
    let optionData = await optionConfig();
    currentFuture = {
      instrument_token: optionData.currentFuture.token,
      tradingsymbol: optionData.currentFuture.symbol,
      lot_size: 30,
    }
    futureToken = optionData.currentFuture.token;

    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken]);

    setTimeout(function () {
      currentPrice = ticksCache[futureToken].last_price;
      console.log('Base price set:', currentPrice);
      setTimeout(function () {
        console.log('Strategy started');
      }, 5000);
    }, 10000);
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

  if (currentPrice === 0) currentPrice = ticksCache[futureToken].last_price;
  checkBreakout();
}

async function checkBreakout() {
  if (!ticksCache[futureToken] || currentPrice === 0) return;

  let lastPrice = ticksCache[futureToken].last_price;
  let priceMove = lastPrice - currentPrice;

  // Check for +25 breakout (BUY)
  if (isFirstTrade && priceMove >= triggerLevel) {
    console.log('BUY Breakout detected:', priceMove);
    placeBreakoutOrder('BUY');
    isFirstTrade = false;
  }
  // Check for -25 breakout (SELL)
  else if (isFirstTrade && priceMove <= -triggerLevel) {
    console.log('SELL Breakout detected:', priceMove);
    placeBreakoutOrder('SELL');
    isFirstTrade = false;
  }
}

async function placeBreakoutOrder(side) {
  try {
    let lastPrice = ticksCache[futureToken].last_price;

    let eventTrigger_id = eventId();
    eventTrigger[eventTrigger_id] = {
      side: side,
      instrument_token: currentFuture.instrument_token,
      action: 'place_sl_target'
    };

    console.log('Placing', side, 'order at price:', lastPrice);
    PaperTrade.trackOrder_v2(currentFuture, side, strategyTag, 1, [eventTrigger_id]);

  } catch (err) {
    console.log('Error placing breakout order:', err);
  }
}

async function placeTargetStoploss(side, orderPrice) {
  let stopPrice, targetPrice;

  if (side == 'BUY') {
    stopPrice = parseInt(orderPrice - sl_points);
    targetPrice = parseInt(orderPrice + target_points);
  } else {
    stopPrice = parseInt(orderPrice + sl_points);
    targetPrice = parseInt(orderPrice - target_points);
  }

  let slEventId = eventId();
  let targetEventId = eventId();

  let exitSide = side == 'BUY' ? 'SELL' : 'BUY';

  // Store reference to cancel opposite order when one hits
  eventTrigger[slEventId] = {
    action: 'sl_hit',
    oppositeOrderId: targetEventId,
    instrument_token: currentFuture.instrument_token,
    side: exitSide,
    stopPrice: stopPrice
  };

  eventTrigger[targetEventId] = {
    action: 'target_hit',
    oppositeOrderId: slEventId,
    instrument_token: currentFuture.instrument_token,
    side: exitSide,
    targetPrice: targetPrice
  };

  // Place SL order with multiplier quantity
  PaperTrade.trackOrder_slm(currentFuture, exitSide, strategyTag, multiplier, stopPrice, [slEventId]);
  // Place Target order with multiplier quantity
  PaperTrade.trackOrder_limit(currentFuture, exitSide, strategyTag, multiplier, targetPrice, [targetEventId]);

  return {
    slEventId: slEventId,
    targetEventId: targetEventId
  };
}

runStrategy();
