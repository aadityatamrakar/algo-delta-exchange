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
let strategyTag = 'SNX_ORB_25';
let lotSize = 20;       // Sensex lot size
let roundStep = 25;     // Option premium rounding step (nearest 25)
let offsetPct = 0.01;   // Breakout offset = 1% of current option price
let maxLoss = 20000;    // Max loss per side in Rs

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

let futureToken = 265, // SENSEX
  currentExpiryOptions = {};

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

async function runStrategy() {
  try {
    let optionData = await optionConfig('SENSEX');
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);

    await getAccounts();
    ticker([futureToken, ...optionTokens]);

    console.log(strategyTag + ': Initialized. Waiting for 9:30 range candle...');
  } catch (err) {
    console.log('runStrategy error:', err);
  }
}

// Range candle data (set at 9:31)
let rangeSetup = false;
let instrument_CE, instrument_PE;
let ceStrike, peStrike;
let ceRangeHigh, ceRangeLow, peRangeHigh, peRangeLow;
let ceBuyTrigger, ceSellTrigger, peBuyTrigger, peSellTrigger;
let ceOffset, peOffset;   // 1% of each option's range-candle close (set at setup)
let ceQty, peQty;

async function setupRange() {
  try {
    let today = new Date().toISOString().substr(0, 10);

    // Fetch 15-min candle for SENSEX (9:15-9:30 will be index 0)
    let snxCandles = await zapi.historyData(futureToken, '15minute', today, today);
    if (!snxCandles || snxCandles.length === 0) {
      console.log('No SENSEX candle data available, retrying in 30s...');
      setTimeout(setupRange, 30000);
      return;
    }

    let rangeCandle = snxCandles[0];
    console.log('SENSEX 15min range candle:', rangeCandle);

    // Round index high UP and low DOWN to nearest 100 → CE and PE strikes
    // (Sensex strikes are 100 apart — strike grid stays at 100 regardless of roundStep)
    ceStrike = Math.ceil(rangeCandle.high / 100) * 100;
    peStrike = Math.floor(rangeCandle.low / 100) * 100;
    console.log('CE Strike:', ceStrike, '| PE Strike:', peStrike);

    instrument_CE = currentExpiryOptions[ceStrike + 'CE'];
    instrument_PE = currentExpiryOptions[peStrike + 'PE'];

    if (!instrument_CE || !instrument_PE) {
      console.log('Instruments not found in currentExpiryOptions. CE:', ceStrike + 'CE', 'PE:', peStrike + 'PE');
      return;
    }

    // Fetch 15-min candle for the CE and PE option
    let ceCandles = await zapi.historyData(instrument_CE.instrument_token, '15minute', today, today);
    let peCandles = await zapi.historyData(instrument_PE.instrument_token, '15minute', today, today);

    if (!ceCandles || ceCandles.length === 0 || !peCandles || peCandles.length === 0) {
      console.log('Option candle data not available');
      return;
    }

    let ceRangeCandle = ceCandles[0];
    let peRangeCandle = peCandles[0];
    console.log('CE option 15min candle:', ceRangeCandle);
    console.log('PE option 15min candle:', peRangeCandle);

    // Round option price ranges (high UP, low DOWN) to nearest roundStep (25)
    ceRangeHigh = Math.ceil(ceRangeCandle.high / roundStep) * roundStep;
    ceRangeLow = Math.floor(ceRangeCandle.low / roundStep) * roundStep;
    peRangeHigh = Math.ceil(peRangeCandle.high / roundStep) * roundStep;
    peRangeLow = Math.floor(peRangeCandle.low / roundStep) * roundStep;

    // Offset = 1% of the option's range-candle close (separate for CE and PE)
    ceOffset = ceRangeCandle.close * offsetPct;
    peOffset = peRangeCandle.close * offsetPct;

    // Trigger prices = rounded level ± offset
    ceBuyTrigger = ceRangeHigh + ceOffset;   // break above → BUY CE
    ceSellTrigger = ceRangeLow - ceOffset;   // break below → SELL CE
    peBuyTrigger = peRangeHigh + peOffset;   // break above → BUY PE
    peSellTrigger = peRangeLow - peOffset;   // break below → SELL PE

    // Quantity calculation based on fixed loss
    // SL range covers the full option price range (high trigger to low trigger)
    let ceSlRange = (ceRangeHigh - ceRangeLow) + 2 * ceOffset;
    let peSlRange = (peRangeHigh - peRangeLow) + 2 * peOffset;

    let ceLots = Math.max(1, Math.floor(maxLoss / (ceSlRange * lotSize)));
    let peLots = Math.max(1, Math.floor(maxLoss / (peSlRange * lotSize)));

    ceQty = ceLots * lotSize;
    peQty = peLots * lotSize;

    rangeSetup = true;
    console.log('=== RANGE SETUP COMPLETE ===');
    console.log('SENSEX Range - High:', rangeCandle.high, '→ ceStrike:', ceStrike, ' | Low:', rangeCandle.low, '→ peStrike:', peStrike);
    console.log('CE Option Range - High:', ceRangeCandle.high, '→', ceRangeHigh, ' | Low:', ceRangeCandle.low, '→', ceRangeLow, '| offset(1%):', ceOffset.toFixed(2));
    console.log('PE Option Range - High:', peRangeCandle.high, '→', peRangeHigh, ' | Low:', peRangeCandle.low, '→', peRangeLow, '| offset(1%):', peOffset.toFixed(2));
    console.log('CE Triggers - BUY at >', ceBuyTrigger, '| SELL at <', ceSellTrigger, '| SL range:', ceSlRange, '| Qty:', ceQty);
    console.log('PE Triggers - BUY at >', peBuyTrigger, '| SELL at <', peSellTrigger, '| SL range:', peSlRange, '| Qty:', peQty);
    console.log('============================');
  } catch (err) {
    console.log('setupRange error:', err);
  }
}

// Active positions tracking
// { side: 'CE'|'PE', type: 'BUY'|'SELL', entry, sl, qty, instrument, strike, status }
let activePositions = [];

let ticksCache = {};
async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);

  if (rangeSetup) {
    checkBreakoutQ.push({ check: 1 });
    if (activePositions.length > 0) {
      checkSLQ.push({ check: 1 });
    }
  }
}

// Per-direction trigger flags (each can fire once independently)
let ceBuyTriggered = false, ceSellTriggered = false;
let peBuyTriggered = false, peSellTriggered = false;
// Track whether first trade on each side is done (for fresh SL on re-entry)
let ceFirstTradeDone = false, peFirstTradeDone = false;

function calcQty(entryPrice, sl) {
  let slRange = Math.abs(entryPrice - sl);
  if (slRange <= 0) return lotSize;
  return Math.max(lotSize, Math.floor(maxLoss / (slRange * lotSize)) * lotSize);
}

async function checkBreakout() {
  try {
    // CE side breakout
    if (instrument_CE) {
      let ceQuote = ticksCache[instrument_CE.instrument_token];
      if (ceQuote) {
        let cePrice = ceQuote.last_price;

        if (!ceBuyTriggered && cePrice > ceBuyTrigger) {
          ceBuyTriggered = true;
          // Re-entry: use fresh day low (rounded down - 1% of live price) as SL
          let dynOffset = cePrice * offsetPct;
          let sl = ceFirstTradeDone
            ? Math.floor(ceQuote.ohlc.low / roundStep) * roundStep - dynOffset
            : ceSellTrigger;
          let qty = calcQty(cePrice, sl);
          console.log('CE BUY triggered at', cePrice, '| SL:', sl, '| Qty:', qty, ceFirstTradeDone ? '(re-entry, fresh SL)' : '');
          await enterPosition('CE', 'BUY', cePrice, qty, instrument_CE, ceStrike, sl);
        } else if (!ceSellTriggered && cePrice < ceSellTrigger) {
          ceSellTriggered = true;
          // Re-entry: use fresh day high (rounded up + 1% of live price) as SL
          let dynOffset = cePrice * offsetPct;
          let sl = ceFirstTradeDone
            ? Math.ceil(ceQuote.ohlc.high / roundStep) * roundStep + dynOffset
            : ceBuyTrigger;
          let qty = calcQty(cePrice, sl);
          console.log('CE SELL triggered at', cePrice, '| SL:', sl, '| Qty:', qty, ceFirstTradeDone ? '(re-entry, fresh SL)' : '');
          await enterPosition('CE', 'SELL', cePrice, qty, instrument_CE, ceStrike, sl);
        }
      }
    }

    // PE side breakout
    if (instrument_PE) {
      let peQuote = ticksCache[instrument_PE.instrument_token];
      if (peQuote) {
        let pePrice = peQuote.last_price;

        if (!peBuyTriggered && pePrice > peBuyTrigger) {
          peBuyTriggered = true;
          let dynOffset = pePrice * offsetPct;
          let sl = peFirstTradeDone
            ? Math.floor(peQuote.ohlc.low / roundStep) * roundStep - dynOffset
            : peSellTrigger;
          let qty = calcQty(pePrice, sl);
          console.log('PE BUY triggered at', pePrice, '| SL:', sl, '| Qty:', qty, peFirstTradeDone ? '(re-entry, fresh SL)' : '');
          await enterPosition('PE', 'BUY', pePrice, qty, instrument_PE, peStrike, sl);
        } else if (!peSellTriggered && pePrice < peSellTrigger) {
          peSellTriggered = true;
          let dynOffset = pePrice * offsetPct;
          let sl = peFirstTradeDone
            ? Math.ceil(peQuote.ohlc.high / roundStep) * roundStep + dynOffset
            : peBuyTrigger;
          let qty = calcQty(pePrice, sl);
          console.log('PE SELL triggered at', pePrice, '| SL:', sl, '| Qty:', qty, peFirstTradeDone ? '(re-entry, fresh SL)' : '');
          await enterPosition('PE', 'SELL', pePrice, qty, instrument_PE, peStrike, sl);
        }
      }
    }
  } catch (err) {
    console.log('checkBreakout error:', err);
  }
}

async function enterPosition(side, type, entryPrice, qty, instrument, strike, sl) {
  try {
    // Place live order for all accounts
    await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, instrument, type, qty / lotSize);

    activePositions.push({
      side: side,
      type: type,
      strike: strike,
      instrument: instrument,
      instrument_token: instrument.instrument_token,
      entry: entryPrice,
      sl: sl,
      qty: qty,
      status: 'ACTIVE',
      entryTime: new Date()
    });

    console.log('=== POSITION ENTERED ===');
    console.log('Side:', side, '| Type:', type, '| Strike:', strike);
    console.log('Symbol:', instrument.tradingsymbol);
    console.log('Entry:', entryPrice, '| SL:', sl, '| Qty:', qty);
    console.log('========================');
  } catch (err) {
    console.log('enterPosition error:', err);
  }
}

async function checkSL() {
  for (let idx = activePositions.length - 1; idx >= 0; idx--) {
    let pos = activePositions[idx];
    if (pos.status !== 'ACTIVE') continue;

    let quote = ticksCache[pos.instrument_token];
    if (!quote) continue;

    let currentPrice = quote.last_price;
    let slHit = false;

    if (pos.type === 'BUY' && currentPrice <= pos.sl) {
      slHit = true;
    } else if (pos.type === 'SELL' && currentPrice >= pos.sl) {
      slHit = true;
    }

    if (slHit) {
      pos.status = 'CLOSED';
      activePositions.splice(idx, 1);

      let exitType = pos.type === 'BUY' ? 'SELL' : 'BUY';
      let pnl = pos.type === 'BUY'
        ? (currentPrice - pos.entry) * pos.qty
        : (pos.entry - currentPrice) * pos.qty;

      console.log('');
      console.log('╔══════════════════════════════╗');
      console.log('║        STOP LOSS HIT         ║');
      console.log('╚══════════════════════════════╝');
      console.log('Side:', pos.side, '| Strike:', pos.strike, '| Type:', pos.type);
      console.log('Entry:', pos.entry, '| Current:', currentPrice, '| SL was:', pos.sl);
      console.log('P&L:', pnl.toFixed(2), '| Qty:', pos.qty);

      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, pos.instrument, exitType, pos.qty / lotSize);

      // Mark first trade done so next entry on this side uses fresh SL
      if (pos.side === 'CE') ceFirstTradeDone = true;
      else peFirstTradeDone = true;
    }
  }
}

// End of day exit — close all open positions
async function eodExit() {
  console.log('EOD: Squaring off all open positions...');
  for (let pos of activePositions) {
    if (pos.status !== 'ACTIVE') continue;
    let exitType = pos.type === 'BUY' ? 'SELL' : 'BUY';
    await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, pos.instrument, exitType, pos.qty / lotSize);
    pos.status = 'CLOSED';
    console.log('EOD exit:', pos.side, pos.type, pos.strike, '@ qty', pos.qty);
  }
  activePositions = [];
}

var checkBreakoutQ = async.queue(function (task, callback) {
  checkBreakout().then(function () { callback(); });
}, 1);

var checkSLQ = async.queue(function (task, callback) {
  checkSL().then(function () { callback(); });
}, 1);

// Start strategy: initialize well before market open so ticker is ready
// runStrategy();
new CronJob('0 0 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');

// Setup range at 9:31 after 15-min opening candle is complete
new CronJob('0 31 9 * * 1-5', function () {
  setupRangeQ.push({ check: 1 });
}, null, true, 'Asia/Kolkata');

var setupRangeQ = async.queue(function (task, callback) {
  setupRange().then(function () { callback(); });
}, 1);

// EOD exit at 3:20
new CronJob('0 20 15 * * 1-5', eodExit, null, true, 'Asia/Kolkata');

// Process exit at 3:30
new CronJob('0 30 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');

console.log(strategyTag + ': Strategy loaded.');
console.log('lotSize:', lotSize, '| roundStep:', roundStep, '| offset: 1% of option price | maxLoss:', maxLoss);
