const CronJob = require("cron").CronJob;
var request = require('request');
var async = require('async');
var fs = require('fs');
let strategyTag = 'Strangle';
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

let underlying, futureSymbol, futureToken, NIFTY, nearestExpiry, monthlyExpiry, chain, futuresInstrument;
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
      // notify('Options Data Ready, Current Fut: ' + futureSymbol + ' Weekly: ' + nearestExpiry + ' Monthly: ' + monthlyExpiry, channelId);

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
        if (elm.strategy[strategyTag]) {
          lotSize[elm.name] = parseInt(elm.strategy[strategyTag]);
        }
        return lotSize;
      }, {});

      let combineTotalLots = Object.values(strangle_qty).reduce((s, a) => (s += a, s), 0);
      console.log(strangle_qty);

      new CronJob('0 30 9 * * 1-5', async function () {
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

        let upper_strike = (Math.ceil(bn_quote.last_price / 100) * 100) + 100;
        let lower_strike = (Math.floor(bn_quote.last_price / 100) * 100) - 100;
        let upper_strike_option = chain.data.filter(c => (c.expiry == nearestExpiry && c.strike == upper_strike && c.instrument_type == 'CE'));
        let lower_strike_option = chain.data.filter(c => (c.expiry == nearestExpiry && c.strike == lower_strike && c.instrument_type == 'PE'));
        let ATM_Options = [...upper_strike_option, ...lower_strike_option];

        ATM_Options = ATM_Options.map(optionInst => {
          optionInst.instrumentId = instruments[optionInst.tradingsymbol];
          return optionInst;
        });

        // notify(`BN: ${bn_quote.last_price}\nStrangle Strikes: ${upper_strike}CE, ${lower_strike}PE`, channelId);
        async.each(accounts, function (account, cb) {
          (async () => {
            if (strangle_qty[account.name] <= 100) {
              let client = await XtsAccount.loginClient(account);
              placeOrder(client, ATM_Options, strangle_qty[account.name], 1.25, cb);
            } else {
              let orderTranches = tranches(strangle_qty[account.name]);
              let client = await XtsAccount.loginClient(account);
              async.each(orderTranches, function (orderTranch, cb2) {
                placeOrder(client, ATM_Options, orderTranch, 1.25, cb2);
              }, cb);
            }
          })();
        }, function () {
          notify('XTS: Combined '+strategyTag+' lots ' + combineTotalLots, channelId);
        });

      }, null, true, 'Asia/Kolkata');
    }
  } catch (err) {
    console.log(err);
    // notify('Start Error: ' + err.message, channelId);
  }
}

async function placeOrder(client, ATM_Options, straddle_lots = 1, stoploss = 1.25, mcb) {
  let pauseTimer = 1000;
  async.map(ATM_Options, function (optionInstrument, cb) {
      (async () => {
        let firstLegOrder = await client.placeOrder({
          exchangeSegment: client.exchangeInfo.NSEFO,
          exchangeInstrumentID: optionInstrument.instrumentId,
          productType: client.productTypes.NRML,
          orderType: client.orderTypes.Market,
          orderSide: client.orderSide.SELL,
          timeInForce: client.dayOrNet.DAY,
          disclosedQuantity: 0,
          limitPrice: 0,
          stopPrice: 0,
          orderQuantity: optionInstrument.lot_size * straddle_lots,
          orderUniqueIdentifier: strategyTag
        });

        // console.log('firstLegOrder', firstLegOrder);
        if (firstLegOrder && firstLegOrder.type == 'success') {
          let avgPrice, orderCompleted = false;

          do {
            try {
              await pause(pauseTimer);
              pauseTimer = pauseTimer + 2000;

              let orders = await client.getOrderBook();
              if (orders && orders.type == 'success') {
                orders = orders.result;
                let orderIdx = orders.findIndex(order => order.AppOrderID == firstLegOrder.result.AppOrderID);

                if (orders[orderIdx].OrderStatus == 'Filled') {
                  avgPrice = orders[orderIdx].OrderAverageTradedPrice;
                  orderCompleted = true;

                  let slOrder = await client.placeOrder({
                    exchangeSegment: client.exchangeInfo.NSEFO,
                    exchangeInstrumentID: optionInstrument.instrumentId,
                    productType: client.productTypes.NRML,
                    orderType: client.orderTypes.StopMarket,
                    orderSide: client.orderSide.BUY,
                    timeInForce: client.dayOrNet.DAY,
                    disclosedQuantity: 0,
                    limitPrice: 0,
                    stopPrice: Math.round(stoploss * avgPrice),
                    orderQuantity: optionInstrument.lot_size * straddle_lots,
                    orderUniqueIdentifier: strategyTag
                  });
                  // console.log('slOrder', slOrder);
                } else if (orders[orderIdx].OrderStatus == 'Cancelled' || orders[orderIdx].OrderStatus == 'Rejected') {
                  orderCompleted = true;
                }
              }
            } catch (err) {
              orderCompleted = true;
              orderbook.push('Error: ' + client.clientCodes[0]);
              console.log('Error: ' + client.clientCodes[0]);
              console.log(err);
            }
          } while (!orderCompleted);

          cb(null, {
            status: true
          });
        } else if (firstLegOrder) {
          orderbook.push('Error: ' + client.clientCodes[0]);
          console.log('Error: ' + client.clientCodes[0]);
          cb(null, {
            status: false
          });
        } else {
          orderbook.push('Error: ' + client.clientCodes[0]);
          console.log('Error: ' + client.clientCodes[0]);
          cb(null, {
            status: false
          });
        }
      })();
    },
    function () {
      if (mcb) mcb();
    });
}

// runStraddle();
new CronJob('0 25 9 * * 1-5', runStraddle, null, true, 'Asia/Kolkata');
new CronJob('0 59 14 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 30000);
}, null, true, 'Asia/Kolkata');
