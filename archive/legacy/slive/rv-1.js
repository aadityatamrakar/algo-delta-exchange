const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;
const optionConfig = require('../tools/optionInstruments');

// Strategy Config
let channelId = 0;
let strategyTag = 'RV-1';

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

let futureToken, farOtm = 0,
  currentExpiryOptions = {};
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    // if (moment().day() == 3) {
    //   currentExpiryOptions = optionData.nextWeekInstruments;
    // }
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    // farOtm = otmSelector();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    // setTimeout(() => { takeTrade(true); }, 15000);
    new CronJob('0 * * * * 1-5', makeCandles, null, true, 'Asia/Kolkata');
    setTimeout(() => {
      new CronJob('0 */3 * * * 1-5', takeTrade, null, true, 'Asia/Kolkata');
    }, 60 * 1000 * 13);
  } catch (err) {
    console.log(err);
  }
}

let init_pending = true,
  ticksCache = {};
async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);
}

let ce_strike = false, pe_strike, current_atm = 0, OTM = 100, strikePositions = 0;
async function takeTrade(forceTrade = false) {
  let bn_quote = ticksCache[futureToken];
  let atm = (Math.round(bn_quote.last_price / 100) * 100);

  if (!ce_strike) ce_strike = atm + OTM;
  if (!pe_strike) pe_strike = atm - OTM;

  if (current_atm != atm) {
    current_atm = atm;
    let old_tradeObj = printRV(ce_strike, pe_strike);
    let new_tradeObj = printRV(atm + OTM, atm - OTM);

    if (old_tradeObj.ce_rv < new_tradeObj.ce_rv && old_tradeObj.pe_rv < new_tradeObj.pe_rv) {
      if (strikePositions == 1) {
        sendOrder(ce_strike + "CE", "BUY");
        sendOrder(pe_strike + "PE", "BUY");
      }

      sendOrder((atm + OTM) + "CE", "SELL");
      sendOrder((atm - OTM) + "PE", "SELL");
      strikePositions = 1;
      ce_strike = atm + OTM;
      pe_strike = atm - OTM;
    } else if (old_tradeObj.ce_rv < new_tradeObj.ce_rv && strikePositions == 1) {
      sendOrder(ce_strike + "CE", "BUY");
      sendOrder((atm + OTM) + "CE", "SELL");
      ce_strike = atm + OTM;
    } else if (old_tradeObj.pe_rv < new_tradeObj.pe_rv && strikePositions == 1) {
      sendOrder(pe_strike + "PE", "BUY");
      sendOrder((atm - OTM) + "PE", "SELL");
      pe_strike = atm - OTM;
    }
  }
}

function printRV(ce_strike, pe_strike) {
  // let instruments = Object.keys(candlestick);
  let tradeObj = {
    CE: false,
    PE: false
  };

  let ce_instrument = currentExpiryOptions[ce_strike + "CE"].instrument_token;
  let pe_instrument = currentExpiryOptions[pe_strike + "PE"].instrument_token;


  if (candlestick[ce_instrument]) {
    let prices = candlestick[ce_instrument].slice(-14);
    let rv = Math.round(realizedVolatility(prices) * 100);
    tradeObj["CE"] = rv;
  }
  if (candlestick[pe_instrument]) {
    let prices = candlestick[pe_instrument].slice(-14);
    let rv = Math.round(realizedVolatility(prices) * 100);
    tradeObj["PE"] = rv;
  }

  let ce_rv = tradeObj['CE'] ? tradeObj['CE'] : 0;
  let pe_rv = tradeObj['PE'] ? tradeObj['PE'] : 0;

  return {
    ce_strike,
    ce_rv: ce_rv,
    pe_strike,
    pe_rv: pe_rv,
    total_rv: (Math.round(ce_rv + pe_rv * 100)) / 100
  };

}

let optionOrders = false;
async function sendOrder(strike, transType) {
  PaperTrade.trackOrder(currentExpiryOptions[strike], transType, strategyTag);
}

let candlestick = {};
async function makeCandles() {
  let keys = Object.keys(ticksCache);
  for (let i = 0; i < keys.length; i++) {
    let token = keys[i];
    let tick = ticksCache[token];
    let instrument = tick.instrument_token;
    if (!candlestick[instrument]) {
      candlestick[instrument] = [];
    }
    candlestick[instrument].push(tick.last_price);
  }
}

function realizedVolatility(prices) {
  var logReturns = [];
  for (var i = 1; i < prices.length; i++) {
    logReturns.push(Math.log(prices[i] / prices[i - 1]));
  }
  var sum = 0;
  for (var i = 0; i < logReturns.length; i++) {
    sum += Math.pow(logReturns[i], 2);
  }
  return Math.sqrt(sum / logReturns.length) * 15.748015748;
}

runStrategy();

