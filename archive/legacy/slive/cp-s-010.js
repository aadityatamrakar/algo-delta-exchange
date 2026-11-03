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
let strategyTag = 'CP_S_010',
  sl_percent = 1.03, // 20% stop loss (1 - 0.20)
  target_percent = 0.99; // 40% target (1 + 0.40)

let basePrice = 0; // Starting price for tracking movement
let breakoutLevel = 3; // +20/-20 breakout level
let currentDirection = null; // 'CE' or 'PE'
let activeOrderIds = []; // Track active target and SL orders
let isFirstTrade = true;
let strategyCounter = 0; // Counter to track strategy performance (+1 for target, -1 for SL)
let strategyActive = true; // Flag to control if strategy should place new orders

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

            // Handle main order execution - place SL and Target
            if (eventTrigger[eventTrgIdx] && eventTrigger[eventTrgIdx].action == 'place_sl_target') {
              if (update.status == 'Filled') {
                let orderPrice = parseFloat(update.price);
                let stopPrice = parseFloat((orderPrice * sl_percent).toFixed(1));
                let targetPrice = parseFloat((orderPrice * target_percent).toFixed(1));

                let slEventId = eventId();
                let targetEventId = eventId();

                let instrument = currentExpiryOptions[eventTrigger[eventTrgIdx].strike + eventTrigger[eventTrgIdx].type];

                // Store reference to cancel opposite order when one hits
                eventTrigger[slEventId] = {
                  action: 'sl_hit',
                  oppositeOrderId: targetEventId,
                  instrument_token: instrument.instrument_token,
                  direction: eventTrigger[eventTrgIdx].type,
                  stopPrice: stopPrice
                };

                eventTrigger[targetEventId] = {
                  action: 'target_hit',
                  oppositeOrderId: slEventId,
                  instrument_token: instrument.instrument_token,
                  direction: eventTrigger[eventTrgIdx].type,
                  targetPrice: targetPrice
                };

                // Place SL order
                PaperTrade.trackOrder_slm(instrument, 'BUY', strategyTag, 1, stopPrice, [slEventId]);
                // Place Target order
                PaperTrade.trackOrder_limit(instrument, 'BUY', strategyTag, 1, targetPrice, [targetEventId]);

                activeOrderIds = [slEventId, targetEventId];
                eventTrigger[eventTrgIdx] = false;
              }
            }
            // Handle SL hit - cancel target and reverse
            else if (eventTrigger[eventTrgIdx] && eventTrigger[eventTrgIdx].action == 'sl_hit') {
              if (update.status == 'Filled') {
                // Cancel opposite order
                let oppositeId = eventTrigger[eventTrgIdx].oppositeOrderId;
                cancelPendingOrder();

                // Update counter for SL hit
                strategyCounter--;
                console.log('SL hit. Strategy counter:', strategyCounter);
                
                // Check if strategy should stop (counter reaches -2)
                if (strategyCounter <= -2) {
                  strategyActive = false;
                  console.log('Strategy stopped: 2 stop losses hit');
                } else {
                  // Reverse direction and place new trade only if strategy is still active
                  let newDirection = eventTrigger[eventTrgIdx].direction == 'CE' ? 'PE' : 'CE';
                  setTimeout(() => {
                    if (strategyActive) {
                      placeReverseOrder(newDirection);
                    }
                  }, 3000);
                }

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
                cancelPendingOrder();

                // Update counter for target hit
                strategyCounter++;
                console.log('Target hit. Strategy counter:', strategyCounter);
                
                // Check if strategy should stop (counter reaches 1)
                if (strategyCounter >= 1) {
                  strategyActive = false;
                  console.log('Strategy stopped: 1 target hit');
                } else {
                  // Reverse direction and place new trade only if strategy is still active
                  let newDirection = eventTrigger[eventTrgIdx].direction == 'CE' ? 'PE' : 'CE';
                  setTimeout(() => {
                    if (strategyActive) {
                      placeReverseOrder(newDirection);
                    }
                  }, 3000);
                }

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

    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    setTimeout(function () {
      basePrice = ticksCache[futureToken].last_price;
      console.log('Base price set:', basePrice);
      setTimeout(function () {
        startTrade = true;
        console.log('Strategy started');
      }, 5000);
    }, 10000);
  } catch (err) {
    console.log('main err', err);
  }
}

let ticksCache = {},
  startTrade = false;

async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);

  if (startTrade && isFirstTrade) {
    checkBreakout();
  }
}

async function checkBreakout() {
  if (!strategyActive) {
    console.log('Strategy is stopped, no new orders will be placed');
    return;
  }
  
  let bn_quote = ticksCache[futureToken];
  if (!bn_quote || !basePrice) return;

  let currentPrice = bn_quote.last_price;
  let priceMove = currentPrice - basePrice;

  // Check for +20 breakout (CE)
  if (priceMove >= breakoutLevel && (!currentDirection || currentDirection !== 'PE')) {
    console.log('PE Breakout detected:', priceMove);
    currentDirection = 'PE';
    placeBreakoutOrder('PE');
    isFirstTrade = false;
  }
  // Check for -20 breakout (PE)
  else if (priceMove <= -breakoutLevel && (!currentDirection || currentDirection !== 'CE')) {
    console.log('CE Breakout detected:', priceMove);
    currentDirection = 'CE';
    placeBreakoutOrder('CE');
    isFirstTrade = false;
  }
}

async function placeBreakoutOrder(direction) {
  try {
    let bn_quote = ticksCache[futureToken];
    let atm_strike = Math.round(bn_quote.last_price / 100) * 100;

    // Get ATM options
    let option = currentExpiryOptions[atm_strike + direction];

    if (!option) {
      console.log('Option not found for strike:', atm_strike + direction);
      return;
    }

    let eventTrigger_id = eventId();
    eventTrigger[eventTrigger_id] = {
      strike: atm_strike,
      type: direction,
      instrument_token: option.instrument_token,
      action: 'place_sl_target'
    };

    console.log('Placing', direction, 'sell order at strike:', atm_strike);
    PaperTrade.trackOrder_v2(option, 'SELL', strategyTag, 1, [eventTrigger_id]);

  } catch (err) {
    console.log('Error placing breakout order:', err);
  }
}

async function placeReverseOrder(direction) {
  if (!strategyActive) {
    console.log('Strategy is stopped, not placing reverse order');
    return;
  }
  
  console.log('Placing reverse order:', direction);
  try {
    let bn_quote = ticksCache[futureToken];
    let atm_strike = Math.round(bn_quote.last_price / 100) * 100;

    // Get ATM options
    let option = currentExpiryOptions[atm_strike + direction];

    if (!option) {
      console.log('Option not found for reverse strike:', atm_strike + direction);
      return;
    }

    let eventTrigger_id = eventId();
    eventTrigger[eventTrigger_id] = {
      strike: atm_strike,
      type: direction,
      instrument_token: option.instrument_token,
      action: 'place_sl_target'
    };

    currentDirection = direction;
    console.log('Placing reverse', direction, 'sell order at strike:', atm_strike);
    PaperTrade.trackOrder_v2(option, 'SELL', strategyTag, 1, [eventTrigger_id]);

  } catch (err) {
    console.log('Error placing reverse order:', err);
  }
}

// Initialize strategy
runStrategy();

console.log('Momentum Breaker Strategy initialized');
