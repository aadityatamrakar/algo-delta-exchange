const CronJob = require("cron").CronJob;
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker.js');
const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;
const optionConfig = require('../tools/optionInstruments.js');
const async = require('async');
const moment = require('moment');

// Strategy Config
let channelId = 0;
let strategyTag = 'CP_NS_2040',
  sl_percent = 1.20, // 20% stop loss (1 - 0.20)
  target_percent = 0.60; // 40% target (1 + 0.40)

let basePrice = 0; // Starting price for tracking movement
let breakoutLevel = 10; // +20/-20 breakout level
let currentDirection = null; // 'CE' or 'PE'
let isFirstTrade = true;
let strategyCounter = 0; // Counter to track strategy performance (+1 for target, -1 for SL)
let strategyActive = true; // Flag to control if strategy should place new orders

// Internal trade tracking (demo mode)
let activePositions = []; // Track open positions with their SL and Target levels
let tradeHistory = []; // Keep track of all trades

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
  fromDate, toDate;

async function runStrategy() {
  try {
    let optionData = await optionConfig("NIFTY");
    futureToken = 256265;
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
        console.log('Initial settings:', {
          basePrice,
          breakoutLevel,
          sl_percent,
          target_percent,
          strategyTag
        });
        console.log('Paper Trading Mode: Orders will be tracked in PaperTrade model');
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
  
  // Check SL and Target for active positions
  if (startTrade && activePositions.length > 0) {
    checkSLQ.push({ check: 1 });
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

  // Check for +20 breakout (PE - market going up, sell PE)
  if (priceMove >= breakoutLevel && (!currentDirection || currentDirection !== 'PE')) {
    console.log('PE Breakout detected. Price move:', priceMove);
    currentDirection = 'PE';
    placeBreakoutOrder('PE');
    isFirstTrade = false;
  }
  // Check for -20 breakout (CE - market going down, sell CE)
  else if (priceMove <= -breakoutLevel && (!currentDirection || currentDirection !== 'CE')) {
    console.log('CE Breakout detected. Price move:', priceMove);
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

    let optionQuote = ticksCache[option.instrument_token];
    if (!optionQuote) {
      console.log('Option quote not available for:', atm_strike + direction);
      return;
    }

    let entryPrice = optionQuote.last_price;
    let stopLoss = parseFloat((entryPrice * sl_percent).toFixed(1));
    let target = parseFloat((entryPrice * target_percent).toFixed(1));

    // Place Paper Trade Order
    await PaperTrade.trackOrder_v2(option, 'SELL', strategyTag, 1, []);
    
    // Create demo position for tick-based SL/Target tracking
    let position = {
      id: Date.now(),
      direction: direction,
      strike: atm_strike,
      instrument_token: option.instrument_token,
      tradingSymbol: option.tradingsymbol,
      entryPrice: entryPrice,
      entryTime: new Date(),
      stopLoss: stopLoss,
      target: target,
      quantity: 1,
      status: 'ACTIVE',
      slHit: false,
      targetHit: false
    };

    activePositions.push(position);

    console.log('=== NEW POSITION OPENED ===');
    console.log('Direction:', direction);
    console.log('Strike:', atm_strike);
    console.log('Symbol:', option.tradingsymbol);
    console.log('Entry Price:', entryPrice);
    console.log('Stop Loss:', stopLoss, `(${sl_percent}x)`);
    console.log('Target:', target, `(${target_percent}x)`);
    console.log('==================================');

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

    let optionQuote = ticksCache[option.instrument_token];
    if (!optionQuote) {
      console.log('Option quote not available for reverse:', atm_strike + direction);
      return;
    }

    let entryPrice = optionQuote.last_price;
    let stopLoss = parseFloat((entryPrice * sl_percent).toFixed(1));
    let target = parseFloat((entryPrice * target_percent).toFixed(1));

    // Place Paper Trade Order
    await PaperTrade.trackOrder_v2(option, 'SELL', strategyTag, 1, []);
    
    // Create demo position for tick-based SL/Target tracking
    let position = {
      id: Date.now(),
      direction: direction,
      strike: atm_strike,
      instrument_token: option.instrument_token,
      tradingSymbol: option.tradingsymbol,
      entryPrice: entryPrice,
      entryTime: new Date(),
      stopLoss: stopLoss,
      target: target,
      quantity: 1,
      status: 'ACTIVE',
      slHit: false,
      targetHit: false
    };

    activePositions.push(position);
    currentDirection = direction;

    console.log('=== REVERSE POSITION OPENED ===');
    console.log('Direction:', direction);
    console.log('Strike:', atm_strike);
    console.log('Symbol:', option.tradingsymbol);
    console.log('Entry Price:', entryPrice);
    console.log('Stop Loss:', stopLoss, `(${sl_percent}x)`);
    console.log('Target:', target, `(${target_percent}x)`);
    console.log('======================================');

  } catch (err) {
    console.log('Error placing reverse order:', err);
  }
}

async function checkSL() {
  // Use for loop in reverse to safely remove items while iterating
  for (let idx = activePositions.length - 1; idx >= 0; idx--) {
    let position = activePositions[idx];
    
    if (position.status !== 'ACTIVE') continue;

    let currentQuote = ticksCache[position.instrument_token];
    if (!currentQuote) continue;

    let currentPrice = currentQuote.last_price;

    // Check if Stop Loss is hit
    if (currentPrice >= position.stopLoss && !position.slHit) {
      position.slHit = true;
      position.status = 'CLOSED';
      position.exitPrice = currentPrice;
      position.exitTime = new Date();
      position.exitType = 'STOP_LOSS';
      position.pnl = (position.entryPrice - currentPrice) * position.quantity;

      console.log('');
      console.log('╔════════════════════════════════════╗');
      console.log('║        STOP LOSS HIT              ║');
      console.log('╚════════════════════════════════════╝');
      console.log('Position:', position.direction, '@', position.strike);
      console.log('Entry Price:', position.entryPrice);
      console.log('Exit Price:', currentPrice);
      console.log('SL Level:', position.stopLoss);
      console.log('P&L:', position.pnl.toFixed(2));
      console.log('Duration:', Math.round((position.exitTime - position.entryTime) / 1000), 'seconds');
      
      // Place exit paper trade order (BUY to close SELL position)
      let option = currentExpiryOptions[position.strike + position.direction];
      if (option) {
        let exitOrder = await PaperTrade.trackOrder_v2(option, 'BUY', strategyTag, 1, []);
        if (exitOrder && exitOrder.id) {
          console.log('Exit Paper Trade Order placed:', exitOrder.id);
        }
      }
      
      // Update counter for SL hit
      strategyCounter--;
      console.log('Strategy Counter:', strategyCounter);
      
      // Add to trade history
      tradeHistory.push(position);
      
      // Remove from active positions (must be done before placing reverse order)
      activePositions.splice(idx, 1);
      
      // Check if strategy should stop (counter reaches -2)
      if (strategyCounter <= -2) {
        strategyActive = false;
        console.log('');
        console.log('╔════════════════════════════════════╗');
        console.log('║   STRATEGY STOPPED: 2 SL HIT      ║');
        console.log('╚════════════════════════════════════╝');
        return; // Exit immediately, don't check other positions
      } else {
        // Reverse direction and place new trade
        let newDirection = position.direction === 'CE' ? 'PE' : 'CE';
        setTimeout(() => {
          if (strategyActive) {
            placeReverseOrder(newDirection);
          }
        }, 3000);
        return; // Exit after placing reverse order to prevent multiple simultaneous exits
      }
      
    }
    // Check if Target is hit
    else if (currentPrice <= position.target && !position.targetHit) {
      position.targetHit = true;
      position.status = 'CLOSED';
      position.exitPrice = currentPrice;
      position.exitTime = new Date();
      position.exitType = 'TARGET';
      position.pnl = (position.entryPrice - currentPrice) * position.quantity;

      console.log('');
      console.log('╔════════════════════════════════════╗');
      console.log('║         TARGET HIT                ║');
      console.log('╚════════════════════════════════════╝');
      console.log('Position:', position.direction, '@', position.strike);
      console.log('Entry Price:', position.entryPrice);
      console.log('Exit Price:', currentPrice);
      console.log('Target Level:', position.target);
      console.log('P&L:', position.pnl.toFixed(2));
      console.log('Duration:', Math.round((position.exitTime - position.entryTime) / 1000), 'seconds');
      
      // Place exit paper trade order (BUY to close SELL position)
      let option = currentExpiryOptions[position.strike + position.direction];
      if (option) {
        let exitOrder = await PaperTrade.trackOrder_v2(option, 'BUY', strategyTag, 1, []);
        if (exitOrder && exitOrder.id) {
          console.log('Exit Paper Trade Order placed:', exitOrder.id);
        }
      }
      
      // Update counter for target hit
      strategyCounter++;
      console.log('Strategy Counter:', strategyCounter);
      
      // Add to trade history
      tradeHistory.push(position);
      
      // Remove from active positions (must be done before placing reverse order)
      activePositions.splice(idx, 1);
      
      if (strategyCounter >= 1) {
        strategyActive = false;
        console.log('');
        console.log('╔════════════════════════════════════╗');
        console.log('║  STRATEGY STOPPED: 1 TARGET HIT   ║');
        console.log('╚════════════════════════════════════╝');
        return; // Exit immediately, don't check other positions
      } else {
        // Reverse direction and place new trade
        let newDirection = position.direction === 'CE' ? 'PE' : 'CE';
        setTimeout(() => {
          if (strategyActive) {
            placeReverseOrder(newDirection);
          }
        }, 3000);
        return; // Exit after placing reverse order to prevent multiple simultaneous exits
      }
    }
  }
}

// Queue for checking SL to avoid concurrent execution
var checkSLQ = async.queue(function (task, callback) {
  checkSL().then(function (res) {
    callback();
  });
}, 1);

// runStrategy();
new CronJob('45 16 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');

console.log('Momentum Breaker Strategy initialized');
console.log('Paper Trading Mode with Tick-based SL/Target execution');
console.log('Orders tracked in PaperTrade model but SL/Target executed via ticks');
