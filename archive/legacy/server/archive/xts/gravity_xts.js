const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const COG = require('../lib/indicators/cog.js');
const Account = app.models.account;
const XtsAccount = app.models.xtsAccount;
const optionConfig = require('../tools/optionInstruments');

let channelId = 0;
let strategyTag = 'Tesla';

let zapi, public_token;
async function zerodha_init(account) {
  let zapi_n = new zerodha();
  zapi_n.loadConfig(account);
  let login_resp = await zapi_n.login();
  account.lastLogin = (new Date()).toISOString().substr(0, 10);
  account.config = await zapi_n.getConfig();
  public_token = zapi_n.getPublicToken();
  await account.save();
  if (login_resp === false) return false;
  else return zapi_n;
}

let liveFeed;
async function ticker() {
  liveFeed = new kiteTicker({
    api_key: 'kitefront',
    access_token: public_token
  });
  liveFeed.connect();
  liveFeed.on("ticks", checkTicks);
  liveFeed.on("connect", function () {
    console.log('Live Feed Connected');
  });
}

let currentPosition_LTP, currentPosition_SL, currentPosition_Tgt, running_PNL = 0;
async function trackPosition(token) {
  let checkQuote_attempt = 10;
  let position_tick;
  do {
    try {
      liveFeed.subscribe([token]);
      liveFeed.setMode(liveFeed.modeFull, [token]);

      position_tick = await zapi.getQoute(token);
      currentPosition_LTP = position_tick.last_price;
      currentPosition_SL = position_tick.last_price - (135 + running_PNL);
      currentPosition_Tgt = position_tick.last_price + (124 - running_PNL);
    } catch (err) {
      console.log(err);
      await zapi.login();
    }
  }
  while (typeof position_tick != 'object' && checkQuote_attempt > 0);
}

let accounts = [],
  running_accounts = [],
  account_quantities = {};
async function getAccounts() {
  let accountsData = await XtsAccount.loadAccounts(strategyTag);
  accounts = accountsData.accounts;
  running_accounts = accounts;
  account_quantities = accountsData.account_quantities;
}

let futureToken, currentExpiryOptions = {},
  fromDate, toDate,
  currentCandle, strategy_running = true,
  currentDirection, currentPosition, instruments;
async function runStrategy() {
  try {
    let optionData = await optionConfig();
    futureToken = optionData.currentFuture.token;
    currentExpiryOptions = optionData.weeklyInstruments;

    await getAccounts();
    instruments = await XtsAccount.loadInstruments(optionData.weeklyExpiry);
    // notify(accounts.length + ' XTS accounts logged in, total ' + strategyTag + ': ' + combineTotalLots + ' lots', channelId);

    let base_acc = await Account.findById('5fcfd7fd795f486e2440be20');
    zapi = await zerodha_init(base_acc);
    ticker();

    toDate = new Date();
    fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);

    new CronJob('30 * * * * 1-5', getAccounts, null, true, 'Asia/Kolkata');
    new CronJob('0 */5 * * * 1-5', check, null, true, 'Asia/Kolkata');
  } catch (err) {
    console.log(err);
  }
}

function checkTicks(ticks) {
  if (currentPosition) {
    ticks.forEach(async tick => {
      if (tick.instrument_token == currentPosition.instrument_token) {
        // current position tick
        let currentSqfPosition = currentPosition;
        if (tick.last_price < currentPosition_SL) {
          currentPosition = false;
          strategy_running = false;
          await XtsAccount.placeAllAccount(strategyTag, account_quantities, running_accounts, instruments, currentSqfPosition, 'SELL');
          notify(strategyTag + ': XTS SL HIT', channelId);
        }
        if (tick.last_price > currentPosition_Tgt) {
          currentPosition = false;
          strategy_running = false;
          await XtsAccount.placeAllAccount(strategyTag, account_quantities, running_accounts, instruments, currentSqfPosition, 'SELL');
          notify(strategyTag + ': XTS TGT HIT', channelId);
        }
      }
    })
  }
}

async function check() {
  if (strategy_running) {
    let bn_quote;
    let checkQuote_attempt = 10;
    do {
      try {
        checkQuote_attempt--;
        bn_quote = await zapi.getQoute(futureToken);

        if (bn_quote && typeof bn_quote == 'object' && bn_quote.last_price) {
          let candleData = await zapi.historyData(futureToken, '5minute', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
          candleData = await COG(candleData, 0.0004, 15, 14, 3);

          let upper_strike = (Math.ceil(bn_quote.last_price / 100) * 100);
          let lower_strike = (Math.floor(bn_quote.last_price / 100) * 100);

          currentCandle = candleData.slice(-1)[0];

          if (currentDirection != currentCandle.cog_signal) {
            // clear current position
            if (currentPosition) {
              await XtsAccount.placeAllAccount(strategyTag, account_quantities, running_accounts, instruments, currentPosition, 'SELL');
              let position_tick = await zapi.getQoute(currentPosition.instrument_token);
              running_PNL = running_PNL + Math.round(position_tick.last_price - currentPosition_LTP);
              notify(strategyTag + ': PNL ' + running_PNL, channelId);
              currentPosition = false;
            }

            // take new position
            if (currentCandle.cog_signal == 'LONG') {
              currentPosition = currentExpiryOptions[upper_strike + 'CE'];
              // notify(strategyTag + ": BUY " + upper_strike + 'CE', channelId);
            }

            if (currentCandle.cog_signal == 'SHORT') {
              currentPosition = currentExpiryOptions[lower_strike + 'PE'];
              // notify(strategyTag + ": BUY " + lower_strike + 'PE', channelId);
            }

            await XtsAccount.placeAllAccount(strategyTag, account_quantities, running_accounts, instruments, currentPosition, 'BUY');
            trackPosition(currentPosition.instrument_token);

            // update current direction
            currentDirection = currentCandle.cog_signal;
          }
        }
      } catch (err) {
        console.log(err);
        await zapi.login();
      }
    } while (typeof bn_quote != 'object' && checkQuote_attempt > 0);
  }
}

// runStrategy();
new CronJob('0 18 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('0 22 15 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 3000);
}, null, true, 'Asia/Kolkata');
