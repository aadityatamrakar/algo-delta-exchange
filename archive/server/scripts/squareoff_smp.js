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
    closePaperTrading();
    setTimeout(function () {
      process.exit();
    }, 30000);
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

// init();
new CronJob('0 24 15 * * 1-6', init, null, true, 'Asia/Kolkata');
