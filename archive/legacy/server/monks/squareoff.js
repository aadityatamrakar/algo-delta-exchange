const CronJob = require("cron").CronJob;
var async = require('async');
var fs = require('fs');
const notify = require("../lib/notify.js");
let pause = async function (ms) {
  return new Promise((r, c) => setTimeout(r, ms))
}
let channelId = 0;

let app = require('../server.js'),
  Account = app.models.account,
  Papertrade = app.models.PaperTrade,
  zerodha = require('../lib/zerodha.js');

let accounts = [];
let straddle_account_zapi = [];

async function zerodha_init(account) {
  let zapi_n = new zerodha();
  zapi_n.loadConfig(account);
  let login_resp = await zapi_n.login();
  if (login_resp === false) return false;
  else return zapi_n;
}

async function init() {
  try {
    accounts = await Account.find({});
    async.each(accounts, function (account, cb) {
      zerodha_init(account).then(tmp_zapi => {
        if (tmp_zapi) {
          straddle_account_zapi.push(tmp_zapi);
          closePositions(tmp_zapi, cb);
        } else cb();
      });
    }, async function () {
      notify('SquareOff Done', channelId);
      closePaperTrading();
      setTimeout(function () {
        process.exit();
      }, 30000);
    }, null, true, 'Asia/Kolkata');
  } catch (err) {
    notify('Start Error: ' + err.message, channelId);
  }
}

async function closePaperTrading() {
  Papertrade.positions(function (err, data) {
    // console.log(data);
    Object.keys(data.positions).forEach((strategy) => {
      data.positions[strategy] = Object.values(data.positions[strategy]).filter((pos) => (pos.quantity != 0));
      data.positions[strategy].forEach(async (order) => {
        Account.trackOrder({
          instrument_token: order.instrument_token,
          tradingsymbol: order.tradingsymbol,
          lot_size: Math.abs(order.quantity)
        }, (order.quantity > 0 ? 'SELL' : 'BUY'), strategy);
      });
    });
  });
}

let strategies = ["STG1", "STG2", "STG3", "STG4", "STG5", "STG6", "STG7", "STG8", "STG9", "STG10", "STG11", "STG12", "STG13", "STG14", "STG15", "STG16", "STG17", "STG18", "STG19", "STG20", "STG21", "STG22", "STG23", 'SQF'];
async function closePositions(tmp_zapi, cb) {
  try {
    await tmp_zapi.login();
    let orders = await tmp_zapi.orders();
    let closedOrderStatus = ['COMPLETE', 'CANCELLED', 'REJECTED'];
    let strategy_symbols = orders
      .filter(row => (row.product == 'MIS' && strategies.indexOf(row.tag) != -1 && row.exchange == 'NFO'))
      .reduce((symbols, order_row) => {
        symbols[order_row.tradingsymbol] = 1;
        return symbols;
      }, {});
    orders = orders.filter(row => (row.product == 'MIS' && strategies.indexOf(row.tag) != -1 && row.exchange == 'NFO' && closedOrderStatus.indexOf(row.status) == -1));

    for (let i = 0; i < orders.length; i++) {
      await tmp_zapi.exitRegularOrder(orders[i].order_id);
    }

    let positions = await tmp_zapi.positions();
    positions = positions.day.filter((pos) => (pos.product == 'MIS' && pos.exchange == 'NFO' && pos.quantity != 0));
    for (let i = 0; i < positions.length; i++) {
      let transaction_type = positions[i].quantity > 0 ? 'SELL' : 'BUY';

      if (strategy_symbols[positions[i].tradingsymbol]) {
        if (positions[i].tradingsymbol.indexOf('BANKNIFTY') != -1 && Math.abs(positions[i].quantity) > 2500) {
          let totalQuantity = Math.abs(positions[i].quantity);
          let runTimes = totalQuantity / 2500;

          for (let j = 0; j < runTimes; j++) {
            let resp = await tmp_zapi.orderFNO({
              tradingsymbol: positions[i].tradingsymbol,
              transaction_type: transaction_type,
              order_type: "MARKET",
              quantity: (totalQuantity > 2500 ? 2500 : totalQuantity),
              trigger_price: 0,
              price: 0,
              tag: "SQF"
            });
            totalQuantity = totalQuantity - 2500;
            console.log(resp);
          }
        } else {
          let resp = await tmp_zapi.orderFNO({
            tradingsymbol: positions[i].tradingsymbol,
            transaction_type: transaction_type,
            order_type: "MARKET",
            quantity: Math.abs(positions[i].quantity),
            trigger_price: 0,
            price: 0,
            tag: "SQF"
          });
          console.log(resp);
        }
      }
    }

    let total = positions.net.reduce((s, a) => (s += a.m2m), 0);
    cb(null, tmp_zapi.credentials.user_id + ' DAY PNL: ' + Math.round(total));
  } catch (err) {
    cb(null, tmp_zapi.credentials.user_id + ' SquareOff Failed');
  }
}

// init();
new CronJob('0 24 15 * * 1-5', init, null, true, 'Asia/Kolkata');
