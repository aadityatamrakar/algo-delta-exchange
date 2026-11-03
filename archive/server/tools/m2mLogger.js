const CronJob = require("cron").CronJob;
const app = require('../server.js');
const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;
const StrategyPNL = app.models.strategyPNL;
const Report = app.models.report;
const zerodha = require('./../lib/zerodha.js');
const kiteTicker = require('./../lib/KiteTicker');

let liveFeed, connected = false;
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

async function ticker() {
  liveFeed = new kiteTicker({
    api_key: 'kitefront',
    access_token: public_token
  });
  liveFeed.connect();
  liveFeed.on("ticks", checkTicks);
  liveFeed.on("connect", function () {
    console.log('Live Feed Connected');
    connected = true;
    liveFeed.subscribe(alreadySubscribed);
    liveFeed.setMode(liveFeed.modeFull, alreadySubscribed);
  });
}
let alreadySubscribed = [];
async function subs(subscribeInstruments) {
  do {
    if (connected) {
      subscribeInstruments = Array.from(new Set(subscribeInstruments));
      subscribeInstruments = subscribeInstruments.filter(c => alreadySubscribed.indexOf(c) == -1);
      if (subscribeInstruments.length > 0) {
        console.log('subscribing', subscribeInstruments);
        liveFeed.subscribe(subscribeInstruments);
        liveFeed.setMode(liveFeed.modeFull, subscribeInstruments);
        alreadySubscribed.push(...subscribeInstruments);
        subscribeInstruments = [];
      }
    }
  } while (subscribeInstruments.length != 0);
}
let ticksCache = {};
async function checkTicks(ticks) {
  ticks = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});

  Object.assign(ticksCache, ticks);
}
let positions = {
  accounts: []
};
async function init() {
  let masterId = app.get('masterId');
  let base_acc = await Account.findById(masterId);
  zapi = await zerodha_init(base_acc);

  ticker();
  new CronJob('5,25,45 * * * * 1-5', fetchPositions, null, true, 'Asia/Kolkata');
  new CronJob('*/10 * * * * 1-5', savePNL, null, true, 'Asia/Kolkata');
}

function calcPNL(positionCheck = false) {
  let records = positions.accounts.map(function (account, idx) {
    let total_m2m = 0;
    let positionOpen = false;
    let openLots = {
      CE: 0,
      PE: 0
    };
    positions.accounts[idx].positions.forEach(function (position) {
      if (position.quantity != 0) positionOpen = true;
      if (ticksCache[position.instrument_token]) {
        if (position.quantity > 0) {
          position.m2m = ((position.sell_price * position.sell_quantity) + (Math.abs(position.quantity) * ticksCache[position.instrument_token].last_price)) - (position.buy_price * position.buy_quantity);
        } else if (position.quantity < 0) {
          position.m2m = (position.sell_price * position.sell_quantity) - ((position.buy_price * position.buy_quantity) + (Math.abs(position.quantity) * ticksCache[position.instrument_token].last_price));
        }
      }
      if (position.tradingsymbol.substr(-2) == 'CE') openLots.CE += position.quantity;
      else if (position.tradingsymbol.substr(-2) == 'PE') openLots.PE += position.quantity;
      total_m2m += position.m2m;
    });
    positions.accounts[idx].total = total_m2m;
    positions.accounts[idx].totalAbs = Math.abs(positions.accounts[idx].total);
    return positionCheck || positionOpen ? {
      strategy: account.accountId,
      m2m: total_m2m,
      open: openLots,
      ts: new Date()
    } : positionOpen;
  });
  records = records.filter(c => c.m2m && c.m2m != 0);
  return records;
}

async function savePNL() {
  let records = calcPNL();
  if (records.length > 0) StrategyPNL.create(records);
  // saveDayPNL();
}

async function saveDayPNL() {
  let todayDate = new Date();
  todayDate.setHours(0);
  todayDate.setMilliseconds(0);
  todayDate.setMinutes(0);
  todayDate.setSeconds(0);

  let records = calcPNL(true);
  let daily_report = records.map(c => {
    return {
      clientCode: c.strategy,
      platform: 'paper',
      strategy: c.strategy,
      pnl: parseInt(c.m2m),
      ts: todayDate
    }
  });

  Report.create(daily_report, function () {
    console.log('daily report saved');
  });
}

async function fetchPositions() {
  PaperTrade.positions(function (err, resp) {
    positions = resp;
    let order_tokens = Object.values(resp.orders).reduce((allTokens, orders) => {
      let tmp = orders.reduce((tokens, order) => {
        tokens.push(order.instrument_token);
        return tokens;
      }, []);
      allTokens.push(...tmp);
      return allTokens;
    }, []);

    subs(order_tokens);
  });
}

// init();
new CronJob('0 15 9 * * 1-5', init, null, true, 'Asia/Kolkata');
new CronJob('50 29 15 * * 1-5', function () {
  saveDayPNL();
  setTimeout(process.exit, 6000);
}, null, true, 'Asia/Kolkata');
