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

let ignorePaperSqf = ['AudiB1', 'AudiB2', 'MB-2k', 'Volvo2', 'T3', 'B4', 'AudiTT', 'AudiTT2', 'Hedge', 'Strangle2k', "STG16", "STG17"];
async function closePaperTrading() {
  Papertrade.positions(function (err, data) {
    // console.log(data);
    Object.keys(data.positions).forEach((strategy) => {
      if (ignorePaperSqf.indexOf(strategy) == -1) {
        data.positions[strategy] = Object.values(data.positions[strategy]).filter((pos) => (pos.quantity != 0));
        data.positions[strategy].forEach(async (order) => {
          Account.trackOrder({
            instrument_token: order.instrument_token,
            tradingsymbol: order.tradingsymbol,
            lot_size: Math.abs(order.quantity)
          }, (order.quantity > 0 ? 'SELL' : 'BUY'), strategy);
        });
      }
    });
  });
}

let strategies = [
  "AlgoEQ",
  "Index",
  "Index_Old",
  "Birbal_AI",
  "Casino",
  "Tesla",
  "TR",
  "Pi",
  "ITCRT",
  "LX1",
  "LX2",
  "LX3",
  "LX4",
  "STG3",
  "STG4",
  "Chai",
  "Spider",
  "F2",
  "ST1",
  "BTS",
  "BBT",
  "BBT5",
  "BBTn5",
  "iStraddle",
  "Strangle",
  "mStrangle",
  "nStrangle",
  "uStrangle",
  "LowRisk",
  "mLowRisk",
  "uLowRisk",
  "Joker",
  "Math_AI",
  "Bahubali",
  "Birbal_LMT",
  "ITC",
  "S1",
  "Urvashi",
  "mStrangleT",
  "uStrangleT",
  "Strangle40",
  "Strangle60",
  "SQF",
  "STG1",
  "STG2",
  "STG5",
  "STG6",
  "STG7",
  "STG8",
  "STG9",
  "STG10",
  "STG11",
  "STG12",
  "STG13",
  "STG14",
  "STG15",
  "STG16",
  "STG17",
  "STG18",
  "STG19",
  "STG20",
  "STG21",
  "STG22",
  "STG23",
  "MTM_1",
  "STGL-120",
  "STGL-160",
  "Strangle240",
  "MB-2k",
  "MB-N700", "MB-10", "AudiB1", "AudiB2", "AudiN1", "AudiN2", "Banknifty12", "Nifty12",
  "Ford", "Ford2", "Ford3", "AudiB3", "AudiB4", "AudiT60", "AudiTT", "AudiTT2",
  'AudiT80R', 'AudiT120R', 'AudiB80R', 'AudiB120R', 'B5', 'B4', 'T4', 'T3', 'Volvo', 'Volvo2', "TWS", 'V1', 'V2', 'Honda2k'
];
strategies = Array.from(new Set(strategies));
async function closePositions(tmp_zapi, cb) {
  try {
    await tmp_zapi.login();
    let orders = await tmp_zapi.orders();
    let closedOrderStatus = ['COMPLETE', 'CANCELLED', 'REJECTED'];
    let strategy_symbols = orders
      .filter(row => (strategies.indexOf(row.tag) != -1 && row.exchange == 'NFO'))
      .reduce((symbols, order_row) => {
        symbols[order_row.tradingsymbol] = 1;
        return symbols;
      }, {});
    orders = orders.filter(row => (strategies.indexOf(row.tag) != -1 && row.exchange == 'NFO' && closedOrderStatus.indexOf(row.status) == -1));

    for (let i = 0; i < orders.length; i++) {
      await tmp_zapi.exitRegularOrder(orders[i].order_id);
    }

    let positions = await tmp_zapi.positions();
    positions = positions.day.filter((pos) => (pos.tradingsymbol.indexOf('BANKNIFTY') != -1 && pos.exchange == 'NFO' && pos.quantity != 0));
    for (let i = 0; i < positions.length; i++) {
      let transaction_type = positions[i].quantity > 0 ? 'SELL' : 'BUY';

      if (strategy_symbols[positions[i].tradingsymbol]) {
        if (positions[i].tradingsymbol.indexOf('BANKNIFTY') != -1 && Math.abs(positions[i].quantity) > 1200) {
          let totalQuantity = Math.abs(positions[i].quantity);
          let runTimes = totalQuantity / 1200;

          for (let j = 0; j < runTimes; j++) {
            let resp = await tmp_zapi.orderFNO({
              tradingsymbol: positions[i].tradingsymbol,
              transaction_type: transaction_type,
              order_type: "MARKET",
              quantity: (totalQuantity > 1200 ? 1200 : totalQuantity),
              trigger_price: 0,
              price: 0,
              tag: "SQF"
            });
            totalQuantity = totalQuantity - 1200;
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
new CronJob('0 28 15 * * 1-5', init, null, true, 'Asia/Kolkata');
