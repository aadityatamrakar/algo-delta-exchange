const moment = require('moment');
const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;
const optionConfig = require('../tools/optionInstruments');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Strategy Config
let channelId = 0;
let strategyTag = 'Strangle2k';

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

let liveFeed, connected = false;
async function ticker(subs) {
  liveFeed = new kiteTicker({
    api_key: 'kitefront',
    access_token: public_token
  });
  liveFeed.connect();
  liveFeed.on("ticks", checkTicks);
  liveFeed.on("connect", function () {
    console.log('Live Feed Connected');
    connected = true;
    liveFeed.subscribe(subs);
    liveFeed.setMode(liveFeed.modeFull, subs);
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

let strategy_running = false;
let futureToken, currentExpiryOptions = {},
  ce_strike = false,
  currentExpiry = '',
  pe_strike = false;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = 260105;
    currentExpiry = optionData.weeklyExpiry;
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken]);

    new CronJob('50 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
    new CronJob('30 * * * * 1-5', fetchPositions, null, true, 'Asia/Kolkata');
    new CronJob('0 17 9 * * 1-5', takeTrade, null, true, 'Asia/Kolkata');
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

  checkPNL();
}

let CE_opt, PE_opt, CE_Entry, PE_Entry, CE_SL, PE_SL, SL_percent = 1.4;
async function takeTrade() {
  let bn_quote = ticksCache[futureToken];

  if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
    let atm_strike = Math.round(bn_quote.last_price / 100) * 100;
    ce_strike = atm_strike + 4000;
    pe_strike = atm_strike - 4000;
    console.log(atm_strike, ce_strike, pe_strike);
    console.log(moment().format('YYYY-MM-DD'), currentExpiry);
    if (moment().format('YYYY-MM-DD') == currentExpiry) {
      ce_strike = atm_strike + 2500;
      pe_strike = atm_strike - 2500;
    }

    let round_ce_strike = Math.round(ce_strike / 500) * 500;
    let round_pe_strike = Math.round(pe_strike / 500) * 500;
    if (round_ce_strike < ce_strike) round_ce_strike += 500;
    if (round_pe_strike > pe_strike) round_pe_strike -= 500;

    CE_opt = currentExpiryOptions[round_ce_strike + 'CE'];
    PE_opt = currentExpiryOptions[round_pe_strike + 'PE'];

    console.log(CE_opt, PE_opt);

    for (let i = 0; i < 96; i++) {
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, CE_opt, 'SELL');
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, PE_opt, 'SELL');
      await sleep(1000);
    }
  }
}

let exit_done = false;
let positions = [];
async function checkPNL() {
  try {
    if (positions.accounts && Object.keys(positions.accounts).length > 0) {
      positions.accounts.forEach(async function (account, idx) {
        if (account.accountId == 'Strangle2k' && strategy_running) {
          let total_m2m = 0;
          positions.accounts[idx].positions.forEach(function (position) {
            if (ticksCache[position.instrument_token]) {
              if (position.quantity > 0) {
                position.m2m = ((position.sell_price * position.sell_quantity) + (Math.abs(position.quantity) * ticksCache[position.instrument_token].last_price)) - (position.buy_price * position.buy_quantity);
              } else if (position.quantity < 0) {
                position.m2m = (position.sell_price * position.sell_quantity) - ((position.buy_price * position.buy_quantity) + (Math.abs(position.quantity) * ticksCache[position.instrument_token].last_price));
              }
            }
            total_m2m += position.m2m;
          });
          positions.accounts[idx].total = total_m2m;
          positions.accounts[idx].totalAbs = Math.abs(positions.accounts[idx].total);
          // console.log(total_m2m);
          if (total_m2m < -100000) {
            strategy_running = false;
            notify(strategyTag + ': SL HIT', channelId);
            exit_done = true;
            for (let i = 0; i < 96; i++) {
              Account.placeAllAccount(strategyTag, account_quantities, running_accounts, CE_opt, 'BUY');
              Account.placeAllAccount(strategyTag, account_quantities, running_accounts, PE_opt, 'BUY');
              await sleep(1000);
            }
            await sleep(1000);
            process.exit();

          }
        }
      });
    }
  } catch (err) {
    console.log(err);
  }
}

// runStrategy();
new CronJob('0 12 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 28 15 * * 1-5', async function () {
  if (!exit_done) {
    exit_done = true;
    for (let i = 0; i < 96; i++) {
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, CE_opt, 'BUY');
      Account.placeAllAccount(strategyTag, account_quantities, running_accounts, PE_opt, 'BUY');
      await sleep(1000);
    }
  }
}, null, true, 'Asia/Kolkata');
new CronJob('0 31 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
