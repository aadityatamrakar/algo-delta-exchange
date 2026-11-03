const CronJob = require("cron").CronJob;
// const notify = require("../lib/notify.js");
const app = require('../server.js');
const Account = app.models.account;
const zerodha = require('../lib/zerodha.js');
const Link = require('./../tools/process-link.js');
const kiteTicker = require('../lib/KiteTicker.js');
// const debounce = require('./../lib/debounce');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const fs = require('fs');

Link.on('connect', _ => console.log('Connected to Link'));

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
  liveFeed.on("error", function (error) {
    console.log('Live Feed Error', error);
  });
  liveFeed.on("close", function () {
    console.log('Live Feed Closed');
  });
  liveFeed.on("ticks", checkTicks);
  liveFeed.on("message", fillQuotes);
  liveFeed.on("connect", function () {
    console.log('Live Feed Connected');
    liveFeed.subscribe(subs);
    liveFeed.setMode(liveFeed.modeQuote, subs);
    setTimeout(fetchLimits, 5000);
  });
}

let sentReq = {};
async function fillQuotes(msg) {
  // console.log(msg);
  if (msg.type === 'quote') {
    let token = parseInt(msg.id);
    if (sentReq[token]) {
      let tokens = sentReq[token];
      if (sentReq[token].length == msg.data.length) {
        console.log('fillQuotes', token, tokens.length);
        for (let i = 0; i < tokens.length; i++) {
          try {
            stockMap[tokens[i]].lower_limit = msg.data[i][0];
            stockMap[tokens[i]].upper_limit = msg.data[i][1];
          } catch (e) { }
        }
      } else {
        console.log('fillQuotes', token, tokens.length, msg.data.length);
      }
    }
  }
}

async function fetchLimits() {
  let stocksInstruments = Object.keys(stockMap);
  let chunks = [];
  for (let i = 0; i < stocksInstruments.length; i += 300) {
    chunks.push(stocksInstruments.slice(i, i + 300));
  }
  for (let i = 0; i < chunks.length; i++) {
    console.log('fetching', i);
    sentReq[chunks[i][0]] = chunks[i];
    chunks[i] = chunks[i].map((s) => parseInt(s));
    liveFeed.quote(chunks[i][0], chunks[i]);
    // sentReq[stocksInstruments[i]] = [stocksInstruments[i]];
    // liveFeed.quote(stocksInstruments[i], [stocksInstruments[i]]);
    await sleep(1000);
  }
  fs.writeFileSync('./stock_bse_limits.json', JSON.stringify(stocksInstruments));
  startCheck = true;
  stocksInstruments = Object.keys(stockMap).map((s) => parseInt(s));
  liveFeed.subscribe(stocksInstruments);
  liveFeed.setMode(liveFeed.modeQuote, stocksInstruments);
  console.log('Limits Fetched');
}

let stockMap = {};
async function runStrategy() {
  try {
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    let stocks = require('./../../stock_bse.json');
    let tokens = stocks.map((s) => (stockMap[s.instrument_token] = s, parseInt(s.instrument_token)));
    console.log(tokens);
    ticker(tokens.slice(0, 3));
    setInterval(saveStocks, 1000);
  } catch (err) {
    console.log('main err', err);
  }
}

async function saveStocks() {
  let stocks = Object.values(stockMap)
    .filter((s) => (s.last_price == s.lower_limit || s.last_price == s.upper_limit))
    .map((s) => {
      return {
        bq: s.buy_quantity,
        tk: s.instrument_token,
        p: s.last_price,
        lc: s.lower_limit,
        sq: s.sell_quantity,
        s: s.tradingsymbol,
        type: s.type,
        uc: s.upper_limit,
        ts: s.timestamp,
        v: s.volume,
      };
    });
  fs.writeFileSync('./live_quotes.json', JSON.stringify(stocks));
  Link.emit("emit_room", "BSE", "tracker", stocks);
  // console.log('');
}

let ticksCache = {};
let startCheck = false;
async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);
  // console.log(ticks);
  if (startCheck) checkForLimits();
}

// let msg = [];
// async function sendMessage() {
//   // send msg in chunks of 5
//   for (let i = 0; i < msg.length; i += 20) {
//     let chunk = msg.slice(i, i + 20);
//     notify(chunk.join('\n'));
//     await sleep(300);
//   }
//   msg = [];
// }

// const notifyD = debounce(sendMessage, 3000);

let informedStocks = [];
setInterval(() => {
  informedStocks = [];
  console.log('Cleared informedStocks');
}, 3600000);
function checkForLimits() {
  for (const token in ticksCache) {
    stockMap[token].last_price = ticksCache[token].last_price;
    stockMap[token].buy_quantity = ticksCache[token].buy_quantity;
    stockMap[token].sell_quantity = ticksCache[token].sell_quantity;
    stockMap[token].timestamp = ticksCache[token].last_trade_time;
    stockMap[token].volume = ticksCache[token].volume;
    // if (informedStocks.includes(stock.tradingsymbol)) continue;
    // else {
    //   const tick = ticksCache[token];
    //   const vol = tick.last_quantity * tick.last_price;
    //   if (vol > 5000000) {
    //     // msg.push(`50L:\t${stock.tradingsymbol}\t:\t${vol}\n`);
    //     console.log('50L: ', stock.tradingsymbol);
    //     // notifyD();
    //     informedStocks.push(stock.tradingsymbol);
    //   }
    // }
  }
}

runStrategy();
new CronJob('0 15 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
