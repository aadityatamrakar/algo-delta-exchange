// const app = require('./server/server.js');
// const Account = app.models.account;
const zerodha = require('../lib/zerodha.js');
const notify = require("../lib/notify.js");
const COG = require("../lib/indicators/cog");
let channelId = 0;
let strategyTag = 'Delta';

const kiteTicker = require('../lib/KiteTicker');
const optionConfig = require('../tools/optionInstruments');
let fs = require('fs');
let async = require('async');
let moment = require('moment');

let m = (new Date()).getTime();
let txtFile = fs.createWriteStream(m + '.txt', 'utf8');
let liveFeed;
const public_token = false;
async function ticker(subs) {
  liveFeed = new kiteTicker({
    api_key: 'kitefront',
    access_token: public_token
  });
  liveFeed.connect();
  liveFeed.on("ticks", checkTicks);
  liveFeed.on("connect", function () {
    console.log('Live Feed Connected');
    console.log('subscribing', subs);
    liveFeed.subscribe(subs);
    liveFeed.setMode(liveFeed.modeFull, subs);
  });
}

let indexToken, futureToken, futureSymbol, currentExpiryOptions, zapi, timestamp;
async function init() {
  zapi = new zerodha();
  // let account = await Account.findById('601d0533e84b793c322b1e67');
  // zapi.loadConfig(account);
  // await zapi.login();
  let optionData = await optionConfig();
  futureToken = optionData.currentFuture.token;
  futureSymbol = optionData.currentFuture.symbol;
  indexToken = 260105;
  currentExpiryOptions = optionData.weeklyInstruments;
  let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);
  ticker([futureToken, indexToken, ...optionTokens]);
}

let futurePrice = 0,
  indexPrice = 0,
  ATM_strike = 0,
  ATM_CE = 0,
  ATM_PE = 0,
  ticksCache = {},
  orderSend = true;
async function checkTicks(ticks) {
  ticks = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});

  Object.assign(ticksCache, ticks);
  if (ticksCache[futureToken]) futurePrice = -1 * ticksCache[futureToken].depth['buy'][0].price;
  else futurePrice = 0;
  if (ticksCache[indexToken]) indexPrice = ticksCache[indexToken].last_price;
  else indexPrice = 0;
  timestamp = moment(ticksCache[futureToken].timestamp, 'X').add(330, 'minutes').format('HH:mm:ss');

  ATM_strike = Math.abs(Math.round(futurePrice / 100) * 100);
  ATM_strike_Down = ATM_strike;
  ATM_strike_UP = ATM_strike;
  checkProfit(ATM_strike, ticksCache[currentExpiryOptions[ATM_strike + 'CE'].instrument_token].depth['sell'][0].price, -1 * ticksCache[currentExpiryOptions[ATM_strike + 'PE'].instrument_token].depth['buy'][0].price);

  ATM_strike_Down -= 100;
  checkProfit(ATM_strike_Down, ticksCache[currentExpiryOptions[ATM_strike_Down + 'CE'].instrument_token].depth['sell'][0].price, -1 * ticksCache[currentExpiryOptions[ATM_strike_Down + 'PE'].instrument_token].depth['buy'][0].price);

  ATM_strike_UP += 100;
  checkProfit(ATM_strike_UP, ticksCache[currentExpiryOptions[ATM_strike_UP + 'CE'].instrument_token].depth['sell'][0].price, -1 * ticksCache[currentExpiryOptions[ATM_strike_UP + 'PE'].instrument_token].depth['buy'][0].price);
}

async function checkProfit(strike, ATM_CE_tmp, ATM_PE_tmp) {
  index_2 = indexPrice + 1000;
  diff = index_2 - indexPrice;
  future_2 = futurePrice + diff;
  let ATM_CE_2_tmp = strike < index_2 ? strike - index_2 : 0;
  let ATM_PE_2_tmp = strike > index_2 ? strike - index_2 : 0;
  let case_1 = Math.round((future_2 - futurePrice) + (ATM_CE_2_tmp + ATM_PE_2_tmp) + (ATM_CE_tmp + ATM_PE_tmp));

  index_2 = indexPrice - 1000;
  diff = index_2 - indexPrice;
  future_2 = futurePrice + diff;
  ATM_CE_2_tmp = strike < index_2 ? strike - index_2 : 0;
  ATM_PE_2_tmp = strike > index_2 ? strike - index_2 : 0;

  let case_2 = Math.round((future_2 - futurePrice) + (ATM_CE_2_tmp + ATM_PE_2_tmp) + (ATM_CE_tmp + ATM_PE_tmp));
  let data = `${timestamp},${indexPrice},${Math.abs(futurePrice)},${strike},${case_1},${case_2},${ATM_CE_tmp},${ATM_PE_tmp}`;
  txtFile.write(`${data}\n`);
  console.log(data);

  // if (orderSend && Math.abs(case_1) == Math.abs(case_2) && Math.abs(case_1) > 70) {
  //   orderSend = false;
  //   sendOrder([
  //     [currentExpiryOptions[strike + 'CE'], 'BUY'],
  //     [{
  //       tradingsymbol: futureSymbol,
  //       lot_size: 25
  //     }, 'SELL'],
  //     [currentExpiryOptions[strike + 'PE'], 'SELL']
  //   ]);
  // }
}

async function sendOrder(orders) {
  async.map(orders, function (order, cb) {
    Account.placeOrder(strategyTag, zapi, order[0], order[1], 1, cb);
  }, function (err, resp) {
    console.log(err, resp);
    notify('orders sent', channelId);
  });
}

// init();

async function calcCog() {
  // 15495426
  let data = require('../../data.json');
  data = await COG(data, 0.0004, 100, 14, 3);
  
  fs.writeFileSync('data2.json', JSON.stringify(data));
}

calcCog();