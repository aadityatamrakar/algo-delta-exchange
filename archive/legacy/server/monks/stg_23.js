const CronJob = require("cron").CronJob;
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const notify = require("../lib/notify.js");

const Tradetron = require('../lib/tradetron');
const tt_authToken = 'cd5e7bb9-3eec-400b-9f6e-4c27ad059534';
// let strategyTag = 'mLowRisk';
let strategyTag = 'STG23';
let channelId = 0;

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


let futureToken, max_pain,
  max_pain_strike,
  fromDate, toDate,
  ce_strike, pe_strike,
  currentPosition, skipTrades = 0;
async function runStrategy() {
  try {
    let optionData = await optionConfig.download();
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;
    max_pain = optionData.max_pain;

    await getAccounts();
    let masterId = app.get('masterId');
    let base_acc = await Account.findById(masterId);
    zapi = await zerodha_init(base_acc);

    new CronJob('30 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');

    new CronJob('20 19 9 * * 1-5', async function () {
      optionData = await optionConfig.download();
      if (optionData && optionData.max_pain) {
        max_pain = optionData.max_pain;

        let optionsStrikes = Object.values(optionData.weeklyInstruments);

        optionsStrikes = optionsStrikes.map(a => {
          a.distance = Math.abs(a.last_price - 120);
          return a;
        }).sort((a, b) => {
          return a.distance - b.distance;
        });

        for (i = 0; i < optionsStrikes.length; i++) {
          if (!ce_strike && optionsStrikes[i].instrument_type == 'CE') ce_strike = optionsStrikes[i].strike;
          if (!pe_strike && optionsStrikes[i].instrument_type == 'PE') pe_strike = optionsStrikes[i].strike;

          if (ce_strike && pe_strike) break;
        }

        ticker([futureToken, currentExpiryOptions[ce_strike + 'CE'].instrument_token, currentExpiryOptions[pe_strike + 'PE'].instrument_token])
      }
    }, null, true, 'Asia/Kolkata');

    new CronJob('0 20 9 * * 1-5', placeTrade, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log(err);
  }
}


let ticksCache = {},
  sl_price = 160;

async function checkTicks(ticks) {
  let ticks2 = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});
  Object.assign(ticksCache, ticks2);
  if (currentPosition) {
    if (ticksCache[max_pain_strike.instrument_token].last_price > sl_price) {
      currentPosition = false;
      await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, max_pain_strike, 'BUY');
    }
  }
}

async function placeTrade() {
  try {
    let bn_quote = ticksCache[futureToken];
    console.log(bn_quote.last_price, max_pain);
    let sellOptionType = max_pain < bn_quote.last_price ? 'PE' : 'CE';

    if (sellOptionType == 'CE')
      max_pain_strike = currentExpiryOptions[ce_strike + sellOptionType];
    else
      max_pain_strike = currentExpiryOptions[pe_strike + sellOptionType];

    let option_quote = ticksCache[max_pain_strike.instrument_token];
    await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, max_pain_strike, 'SELL');
    sl_price = option_quote.last_price * 1.4;
    currentPosition = 'ENTERED';
  } catch (err) {
    console.log(err);
  }
}

// runStrategy();
new CronJob('0 17 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
