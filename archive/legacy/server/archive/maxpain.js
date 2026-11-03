const CronJob = require("cron").CronJob;
var request = require('request');
var async = require('async');
var fs = require('fs');
const notify = require("../lib/notify.js");
let pause = async function (ms) {
  return new Promise((r, c) => setTimeout(r, ms))
}
let channelId = 0;

const Tradetron = require('../lib/tradetron');
const tt_authToken = 'cd5e7bb9-3eec-400b-9f6e-4c27ad059534';
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const Account = app.models.account;
const tranches = (number) => ((new Array(Math.floor(number / 100)).fill(100).concat(number % 100)).filter(c => c > 0));

let accounts = [],
  strangle_qty = {};
let zapi, straddle_account_zapi = [];

async function zerodha_init(account) {
  let zapi_n = new zerodha();
  zapi_n.loadConfig(account);
  let login_resp = await zapi_n.login();
  account.lastLogin = (new Date()).toISOString().substr(0, 10);
  account.config = await zapi_n.getConfig();
  await account.save();
  if (login_resp === false) return false;
  else return zapi_n;
}

async function getInstrumentDetails(underlyings = 'NIFTY') {
  return new Promise((resolve, reject) => {
    var options = {
      'method': 'POST',
      'url': 'https://api.sensibull.com/v1/instrument_details',
      'headers': {
        'content-type': 'application/json;charset=UTF-8',
      },
      json: true,
      body: {
        underlyings: [underlyings]
      }
    };
    request(options, function (error, response) {
      if (error) throw new Error(error);
      resolve(JSON.parse(response.body[underlyings]));
    });
  })
}

async function getReq(url) {
  return new Promise((resolve, reject) => {
    var options = {
      'method': 'GET',
      'url': url,
      'json': true,
    };
    request(options, function (error, response) {
      if (error) resolve(false);
      resolve(response.body);
    });
  });
}

let underlying, futureSymbol, futureToken, NIFTY, nearestExpiry, monthlyExpiry, chain, futuresInstrument, max_pain;
let orderbook = [];
async function runStraddle() {
  try {
    underlying = 'BANKNIFTY';
    NIFTY = await getInstrumentDetails(underlying);
    // fs.writeFileSync('bn.json', JSON.stringify(NIFTY));
    nearestExpiry = Object.values(NIFTY.per_expiry_data).sort((a, b) => (a.daysToExpiry - b.daysToExpiry))[0].expiry;
    chain = await getReq('https://api.sensibull.com/v1/instruments/' + underlying);
    // fs.writeFileSync('fut.json', JSON.stringify(chain));

    if (typeof chain != 'object' || chain.status != true) notify('chain data not available.', channelId);
    else {
      futuresInstrument = chain.data.filter(c => c.segment == 'NFO-FUT');
      let monthlyIdx = futuresInstrument.findIndex(c => (c.expiry.substr(0, 7) == nearestExpiry.substr(0, 7)));
      monthlyExpiry = futuresInstrument[monthlyIdx].expiry;
      futureToken = futuresInstrument[monthlyIdx].instrument_token;
      futureSymbol = futuresInstrument[monthlyIdx].tradingsymbol;
      max_pain = parseInt(NIFTY.per_expiry_data[monthlyExpiry].max_pain);
      // notify('BN Max Pain: ' + max_pain, channelId);
      Tradetron(tt_authToken, 'strike', max_pain);

      let base_acc = await Account.findById('5fcfd7fd795f486e2440be20');
      zapi = await zerodha_init(base_acc);

      accounts = await Account.find({});

      strangle_qty = accounts.reduce((lotSize, elm) => {
        lotSize[elm.name] = parseInt(elm.strategy['BN_Selling']);
        return lotSize;
      }, {});

      let combineTotalLots = Object.values(strangle_qty).reduce((s, a) => (s += a, s), 0);
      console.log(strangle_qty);

      async.eachLimit(accounts, 3, function (accountId, cb) {
        zerodha_init(accountId).then(tmp_zapi => {
          if (tmp_zapi) straddle_account_zapi.push(tmp_zapi);
          cb();
        });
      }, async function () {
        notify(straddle_account_zapi.length + ' accounts logged in, total BN_Selling: ' + combineTotalLots + ' lots', channelId);

        new CronJob('0 20 9 * * 1-5', async function () {

          let bn_quote;
          let checkQuote_attempt = 10;
          do {
            try {
              checkQuote_attempt--;
              bn_quote = await zapi.getQoute(futureToken);
            } catch (err) {
              await zapi.login();
            }
          } while (typeof bn_quote != 'object' && checkQuote_attempt > 0);

          let sellOptionType = max_pain < bn_quote.last_price ? 'PE' : 'CE';
          if (sellOptionType == 'CE') Tradetron(tt_authToken, 'call_sell', 1);
          if (sellOptionType == 'PE') Tradetron(tt_authToken, 'put_sell', 1);
          let max_pain_strike = chain.data.filter(c => (c.expiry == nearestExpiry && c.strike == max_pain && c.instrument_type == sellOptionType));
          if (max_pain_strike.length == 1) {
            max_pain_strike = max_pain_strike[0];
            notify(`BN: ${bn_quote.last_price}\nSELL ${max_pain}${sellOptionType}`, channelId);

            async.each(straddle_account_zapi, function (tmp_zapi, cb) {
              if (strangle_qty[tmp_zapi.credentials.user_id]) {
                if (strangle_qty[tmp_zapi.credentials.user_id] <= 100) placeOrder(tmp_zapi, max_pain_strike, strangle_qty[tmp_zapi.credentials.user_id], cb);
                else {
                  let orderTranches = tranches(strangle_qty[tmp_zapi.credentials.user_id]);
                  async.each(orderTranches, function (orderTranch, cb2) {
                    placeOrder(tmp_zapi, max_pain_strike, orderTranch, cb2);
                  }, cb);
                }
              } else {
                orderbook.push(`${tmp_zapi.credentials.user_id}: Strangle Lots not defined.`);
                cb();
              }
            });
          } else {
            console.log('strikes', max_pain_strike);
          }

        }, null, true, 'Asia/Kolkata');
      });
    }
  } catch (err) {
    notify('Start Error: ' + err.message, channelId);
  }
}

async function placeOrder(tmp_zapi, optionInstrument, straddle_lots = 1, cb) {
  await tmp_zapi.login();

  let firstLegOrder = await tmp_zapi.orderFNO({
    tradingsymbol: optionInstrument.tradingsymbol,
    transaction_type: "SELL",
    order_type: "MARKET",
    quantity: optionInstrument.lot_size * straddle_lots,
    trigger_price: 0,
    price: 0,
    tag: 'BN_Selling'
  });

  if (firstLegOrder && firstLegOrder.status == 'success') cb();
  else {
    notify('BN_Selling Error: ' + tmp_zapi.credentials.user_id, channelId);
    cb();
  }
}

new CronJob('30 18 9 * * 1-5', runStraddle, null, true, 'Asia/Kolkata');
new CronJob('0 0 10 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 30000);
}, null, true, 'Asia/Kolkata');
