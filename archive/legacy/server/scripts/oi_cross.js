const CronJob = require("cron").CronJob;
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const notify = require("../lib/notify.js");

let strategyTag = 'Volvo2';

let zapi, public_token;
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


let futureToken, currentPosition;
async function runStrategy() {
  try {
    let optionData = await optionConfig.download();
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

    await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);
    ticker([futureToken, ...optionTokens]);

    setTimeout(optionsOIPositions, 10000);

    new CronJob('30 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
    new CronJob('0 * * * * 1-5', placeTrade, null, true, 'Asia/Kolkata');
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
}

async function getOptionPrice(token) {
  if (ticksCache[token] && ticksCache[token].last_price) return ticksCache[token].last_price;
  else return 0;
}

async function getOptionOI(token) {
  if (ticksCache[token] && ticksCache[token].oi) return ticksCache[token].oi;
  else return 0;
}

let positionsTaken = {};
function optionsOIPositions() {
  positionsTaken = Object.keys(currentExpiryOptions).reduce((obj, elm) => {
    let option = currentExpiryOptions[elm];
    let strike = option.strike;
    if (!obj[strike]) {
      let ce_option = currentExpiryOptions[strike + 'CE'];
      let pe_option = currentExpiryOptions[strike + 'PE'];

      if (ce_option && pe_option) {
        let total_ce_oi = ticksCache[ce_option.instrument_token] && ticksCache[ce_option.instrument_token].oi ? ticksCache[ce_option.instrument_token].oi : 0;
        let total_pe_oi = ticksCache[pe_option.instrument_token] && ticksCache[pe_option.instrument_token].oi ? ticksCache[pe_option.instrument_token].oi : 0;

        if (total_ce_oi < total_pe_oi) {
          obj[strike] = 'CE';
        } else if (total_pe_oi < total_ce_oi) {
          obj[strike] = 'PE';
        } else {
          obj[strike] = 'NA';
        }
      } else {
        console.log('Missing Option: ' + strike, ce_option, pe_option);
      }
    }
    return obj;
  }, {});
  console.log(positionsTaken);
}

let strategyRunning = true;
async function placeTrade() {
  try {
    if (strategyRunning) {
      let bn_quote = ticksCache[futureToken];
      let atm = Math.round(bn_quote.last_price / 100) * 100;

      let trade_ce_option = currentExpiryOptions[atm + 'CE'];
      let trade_pe_option = currentExpiryOptions[atm + 'PE'];

      let ce_strikes = [atm];
      let pe_strikes = [atm];
      let ce_options = ce_strikes.map(c => currentExpiryOptions[c + 'CE']);
      let pe_options = pe_strikes.map(c => currentExpiryOptions[c + 'PE']);
      let total_ce_oi = ce_options.reduce((s, opt) => (s += ticksCache[opt.instrument_token] && ticksCache[opt.instrument_token].oi ? ticksCache[opt.instrument_token].oi : 0), 0);
      let total_pe_oi = pe_options.reduce((s, opt) => (s += ticksCache[opt.instrument_token] && ticksCache[opt.instrument_token].oi ? ticksCache[opt.instrument_token].oi : 0), 0);

      let trend;
      if (total_ce_oi > total_pe_oi) {
        trend = 'CE';
      } else if (total_pe_oi > total_ce_oi) {
        trend = 'PE';
      }
      console.log(atm, trend, positionsTaken[atm], total_ce_oi, total_pe_oi);

      if (trend != positionsTaken[atm]) {
        if (currentPosition) {
          if (currentPosition.instrument_type == trend) {
            console.log('Already in position');
            return;
          } else {
            // exit position
            Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
            // place new position
            takePosition(trend, trade_ce_option, trade_pe_option);
          }
        } else takePosition(trend, trade_ce_option, trade_pe_option);
      }
    }
  } catch (err) {
    console.log(err);
  }
}

async function takePosition(trend, ce_option, pe_option) {
  if (trend == 'CE') currentPosition = ce_option;
  else currentPosition = pe_option;
  Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'SELL');
  positionsTaken[currentPosition.strike] = trend;
}

// runStrategy();
new CronJob('10 17 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('57 28 15 * * 1-5', function () {
  strategyRunning = false;
  if (currentPosition) {
    Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentPosition, 'BUY');
    currentPosition = false;
  }
}, null, true, 'Asia/Kolkata');
new CronJob('0 31 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
