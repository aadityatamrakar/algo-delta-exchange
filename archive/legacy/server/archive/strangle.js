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
      notify('Options Data Ready, Current Fut: ' + futureSymbol + ' Weekly: ' + nearestExpiry + ' Monthly: ' + monthlyExpiry, channelId);

      let base_acc = await Account.findById('5fcfd7fd795f486e2440be20');
      zapi = await zerodha_init(base_acc);

      accounts = await Account.find({});

      strangle_qty = accounts.reduce((lotSize, elm) => {
        if (elm.strategy && elm.strategy[strategyTag]) {
          lotSize[elm.name] = parseInt(elm.strategy[strategyTag]);
        }
        return lotSize;
      }, {});

      let combineTotalLots = Object.values(strangle_qty).reduce((s, a) => (s += a, s), 0);
      // console.log(strangle_qty);

      async.eachLimit(accounts, 3, function (account, cb) {
        zerodha_init(account).then(tmp_zapi => {
          if (tmp_zapi) straddle_account_zapi.push(tmp_zapi);
          cb();
        });
      }, async function () {
        notify(straddle_account_zapi.length + ' accounts logged in, total ' + strategyTag + ': ' + combineTotalLots + ' lots', channelId);

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

          notify(`BN: ${bn_quote.last_price}\nStrangle Strikes: ${upper_strike}CE, ${lower_strike}PE`, channelId);

          async.each(straddle_account_zapi, function (tmp_zapi, cb) {
            if (strangle_qty[tmp_zapi.credentials.user_id]) {
              if (strangle_qty[tmp_zapi.credentials.user_id] <= 100) {
                placeOrder(tmp_zapi, ATM_Options, strangle_qty[tmp_zapi.credentials.user_id], 1.25, cb);
              } else {
                let orderTranches = tranches(strangle_qty[tmp_zapi.credentials.user_id]);
                async.each(orderTranches, function (orderTranch, cb2) {
                  placeOrder(tmp_zapi, ATM_Options, orderTranch, 1.25, cb2);
                }, cb);
              }
            } else cb();
          }, function () {
            let orderbook_text = orderbook.sort((a, b) => (b.substr(0, 6) < a.substr(0, 6) ? -1 : 1)).join('\n');
            notify(orderbook_text, channelId);
            notify('Strangle placed', channelId);
          });
        }, null, true, 'Asia/Kolkata');
      });
    }
  } catch (err) {
    console.log(err);
    // notify('Start Error: ' + err.message, channelId);
  }
}

async function placeOrder(tmp_zapi, ATM_Options, straddle_lots = 1, stoploss = 1.25, mcb) {
  await tmp_zapi.login();
  let pauseTimer = 1000;
  async.map(ATM_Options, function (optionInstrument, cb) {
      (async () => {
        let firstLegOrder = await tmp_zapi.orderFNO({
          tradingsymbol: optionInstrument.tradingsymbol,
          transaction_type: "SELL",
          order_type: "MARKET",
          quantity: optionInstrument.lot_size * straddle_lots,
          trigger_price: 0,
          price: 0,
          tag: strategyTag
        });

        if (firstLegOrder && firstLegOrder.status == 'success') {
          let avgPrice, orderCompleted = false;

          do {
            try {
              await pause(pauseTimer);
              pauseTimer = pauseTimer + 1000;

              let orders = await tmp_zapi.orders();
              let orderIdx = orders.findIndex(order => order.order_id == firstLegOrder.data.order_id);

              if (orders && orders[orderIdx]) {
                if (orders[orderIdx].status == 'COMPLETE') {
                  let optionPrice = await tmp_zapi.getQoute(optionInstrument.instrument_token);
                  avgPrice = orders[orderIdx].average_price;
                  orderCompleted = true;

                  if (optionPrice.last_price > Math.round(avgPrice * stoploss)) {
                    let slOrder = await tmp_zapi.orderFNO({
                      tradingsymbol: optionInstrument.tradingsymbol,
                      transaction_type: "BUY",
                      order_type: "MARKET",
                      quantity: optionInstrument.lot_size * straddle_lots,
                      trigger_price: 0,
                      price: 0,
                      tag: strategyTag
                    });
                  } else {
                    let slOrder = await tmp_zapi.orderFNO({
                      tradingsymbol: optionInstrument.tradingsymbol,
                      transaction_type: "BUY",
                      order_type: "SL-M",
                      quantity: optionInstrument.lot_size * straddle_lots,
                      trigger_price: Math.round(avgPrice * stoploss),
                      price: 0,
                      tag: strategyTag
                    });
                    if (slOrder && slOrder.status == 'success') {
                      // orderbook.push(`${tmp_zapi.credentials.user_id}: SELL ${optionInstrument.strike}${optionInstrument.instrument_type} ${straddle_lots} Lot @ ${avgPrice.toFixed(2)}`);
                      // orderbook.push(`${tmp_zapi.credentials.user_id}: BUY TRG ${optionInstrument.strike}${optionInstrument.instrument_type} ${straddle_lots} Lot @ ${Math.round(avgPrice * stoploss)}`);
                    }
                  }
                } else if (orders[orderIdx].status == 'REJECTED' || orders[orderIdx].status == 'CANCELLED') {
                  orderCompleted = true;
                  orderbook.push('Error: ' + tmp_zapi.credentials.user_id);
                  console.log('Error: ' + tmp_zapi.credentials.user_id);
                }
              } else {
                orderCompleted = true;
                orderbook.push('Error: ' + tmp_zapi.credentials.user_id);
              }
            } catch (err) {
              orderCompleted = true;
              orderbook.push('Error: ' + tmp_zapi.credentials.user_id);
              console.log('Error: ' + tmp_zapi.credentials.user_id);
              console.log(err);
            }
          } while (!orderCompleted);

          cb(null, {
            status: true
          });
        } else if (firstLegOrder) {
          orderbook.push('Error: ' + tmp_zapi.credentials.user_id);
          console.log('Error: ' + tmp_zapi.credentials.user_id);
          cb(null, {
            status: false
          });
        } else {
          orderbook.push('Error: ' + tmp_zapi.credentials.user_id);
          console.log('Error: ' + tmp_zapi.credentials.user_id);
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

new CronJob('0 25 9 * * 1-5', runStraddle, null, true, 'Asia/Kolkata');
new CronJob('0 59 14 * * 1-5', function () {
  setTimeout(function () {
    process.exit();
  }, 30000);
}, null, true, 'Asia/Kolkata');
