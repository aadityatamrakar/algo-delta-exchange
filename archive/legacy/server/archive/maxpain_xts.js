const CronJob = require("cron").CronJob;
var request = require('request');
var async = require('async');
var fs = require('fs');
const notify = require("../lib/notify.js");
let pause = async function (ms) {
  return new Promise((r, c) => setTimeout(r, ms))
}
let channelId = 0;

const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const Account = app.models.account;
const XtsAccount = app.models.xtsAccount;
const InstrumentDb = app.models.instrument;
const tranches = (number) => ((new Array(Math.floor(number / 100)).fill(100).concat(number % 100)).filter(c => c > 0));

let accounts = [],
  strangle_qty = {};
let zapi;

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

      let base_acc = await Account.findById('5fcfd7fd795f486e2440be20');
      zapi = await zerodha_init(base_acc);
      let instruments = await InstrumentDb.find({
        where: {
          expiry: nearestExpiry
        }
      });
      instruments = instruments.reduce((ob, elm) => {
        ob[elm.tradingsymbol] = parseInt(elm.exchange_token);
        return ob;
      }, {});

      accounts = await XtsAccount.find({});

      strangle_qty = accounts.reduce((lotSize, elm) => {
        lotSize[elm.name] = parseInt(elm.strategy['BN_Selling']);
        return lotSize;
      }, {});

      let combineTotalLots = Object.values(strangle_qty).reduce((s, a) => (s += a, s), 0);
      console.log(strangle_qty);

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

        let sellOptionType, selectOTMStrike, selectOTMOption;
        try {
          sellOptionType = max_pain < bn_quote.last_price ? 'PE' : 'CE';
          if (sellOptionType == 'CE') {
            selectOTMStrike = (Math.ceil(bn_quote.last_price / 100) * 100) + 500;
          } else if (sellOptionType == 'PE') {
            selectOTMStrike = (Math.ceil(bn_quote.last_price / 100) * 100) - 500;
          }
          selectOTMOption = chain.data.filter(c => (c.expiry == nearestExpiry && c.strike == max_pain && c.instrument_type == sellOptionType));

          if (selectOTMOption.length == 1) {
            selectOTMOption = selectOTMOption[0];
            async.each(accounts, function (account, cb) {
              (async () => {
                if (strangle_qty[account.name] <= 100) {
                  let client = await XtsAccount.loginClient(account);
                  placeOrder(client, instruments[selectOTMOption.tradingsymbol], selectOTMOption.lot_size * strangle_qty[account.name], cb);
                } else {
                  let orderTranches = tranches(strangle_qty[account.name]);
                  let client = await XtsAccount.loginClient(account);
                  async.each(orderTranches, function (orderTranch, cb2) {
                    placeOrder(client, instruments[selectOTMOption.tradingsymbol], selectOTMOption.lot_size * orderTranch, cb2);
                  }, cb);
                }
              })();
            }, function () {
              notify('XTS: Combined BN_Selling lots ' + combineTotalLots, channelId);
            });
          } else {
            console.log('strikes', selectOTMOption);
          }
        } catch (err) {
          console.log(err);
        }
      }, null, true, 'Asia/Kolkata');
    }
  } catch (err) {
    console.log('Start Error: ' + err.message, channelId);
  }
}

async function placeOrder(client, instrumentId, lotSize, cb) {
  // console.log(client.clientCodes[0], instrumentId, lotSize);
  let orderResp = await client.placeOrder({
    exchangeSegment: client.exchangeInfo.NSEFO,
    exchangeInstrumentID: instrumentId,
    productType: client.productTypes.NRML,
    orderType: client.orderTypes.Market,
    orderSide: client.orderSide.SELL,
    timeInForce: client.dayOrNet.DAY,
    disclosedQuantity: 0,
    limitPrice: 0,
    stopPrice: 0,
    orderQuantity: lotSize,
    orderUniqueIdentifier: 'BN_Selling'
  });
  console.log(orderResp);
  cb();
}

// runStraddle();
new CronJob('0 19 9 * * 1-5', runStraddle, null, true, 'Asia/Kolkata');
new CronJob('0 0 10 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 30000);
}, null, true, 'Asia/Kolkata');
