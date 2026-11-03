'use strict';
const app = require('../server.js');
const XtsAccount = app.models.xtsAccount;
const FyersAccount = app.models.FyersAccount;
const PaperTrade = app.models.PaperTrade;
const debounce = require('../lib/debounce');
const async = require('async');
const notify = require('../lib/notify');
const CronJob = require("cron").CronJob;
const fs = require('fs');

let rejectedOrders = [];
let cancelledOrders_fyers = [];
try {
  if (fs.existsSync('cancelledOrders_fyers.json')) {
    let tmpOrderIds = JSON.parse(fs.readFileSync('cancelledOrders_fyers.json', 'utf8'));
    cancelledOrders_fyers = tmpOrderIds;
  }
} catch (err) {
  console.log(err);
}

let cancelledOrders_xts = [];
try {
  if (fs.existsSync('cancelledOrders_xts.json')) {
    let tmpOrderIds = JSON.parse(fs.readFileSync('cancelledOrders_xts.json', 'utf8'));
    cancelledOrders_xts = tmpOrderIds;
  }
} catch (err) {
  console.log(err);
}

function sendUpdatePnl() {
  XtsAccount.all_positions(true, function (err, resp) {
    let currentRejectedOrders = [];
    let currentCancelledOrders = [];
    async.eachLimit(resp, 5, function (accountPosition, cb) {
      accountPosition.orders.forEach(c => (c.placed_by = accountPosition.username));
      let accountRejectedOrders = accountPosition.orders.filter(c => c.status == 'REJECTED' || c.status == 'Rejected');
      let accountCancelledOrders = accountPosition.orders.filter(c => c.status == 'CANCELLED' || c.status == 'Cancelled');

      accountCancelledOrders.forEach(c => (c.accountId = accountPosition.accountId));
      currentRejectedOrders.push(...accountRejectedOrders);
      currentCancelledOrders.push(...accountCancelledOrders);
      cb();
    }, function () {
      let msgtext2 = '';
      let msgtext = '';

      async.eachSeries(currentCancelledOrders, function (order, cb) {
        (async () => {
          if (cancelledOrders_xts.indexOf(order.order_id) == -1) {
            if (order.status_message != '') {
              msgtext2 += `${order.placed_by} - ${order.tag} - ${order.status_message == '17070 : The Price is out of the current execution range'?'Option Freeze':order.status_message}\n`;
            }
            cancelledOrders_xts.push(order.order_id);
            if (order.tag != 'brc' && order.tag != '') {
              setTimeout(function () {
                XtsAccount.place_order(String(order.accountId), {
                  "instrumentId": order.ExchangeInstrumentID,
                  "type": order.transaction_type,
                  "quantity": order.quantity,
                  "tag": order.tag
                }, function (err, order_resp) {
                  console.log(order_resp);
                });
                d_sendUpdatePnl();
              }, 5000);
            }
            cb();
          } else cb();
        })()
      }, function () {
        if (msgtext2.length > 0) {
          notify(msgtext2, 0);
        }
        fs.writeFileSync('cancelledOrders_xts.json', JSON.stringify(cancelledOrders_xts));
      });

      async.eachSeries(currentRejectedOrders, function (order, cb) {
        if (rejectedOrders.indexOf(order.order_id) == -1) {
          msgtext += `${order.placed_by} - ${order.tag} - ${order.status_message.indexOf('Insufficient funds') != -1?'Insufficient funds':order.status_message}\n`;
          rejectedOrders.push(order.order_id);
        }
        cb();
      }, function () {
        if (msgtext.length > 0) {
          notify(msgtext, 0);
        }
      });
    });
  });


  FyersAccount.all_positions(true, function (err, resp) {
    let currentRejectedOrders = [];
    let currentCancelledOrders = [];
    async.eachLimit(resp, 5, function (accountPosition, cb) {
      let accountRejectedOrders = accountPosition.orders.filter(c => c.status == 'REJECTED' || c.status == 'Rejected');
      let accountCancelledOrders = accountPosition.orders.filter(c => c.status == 'CANCELLED' || c.status == 'Cancelled');

      accountCancelledOrders.forEach(c => (c.accountId = accountPosition.accountId, c.accountName = accountPosition.name));
      currentRejectedOrders.push(...accountRejectedOrders);
      currentCancelledOrders.push(...accountCancelledOrders);
      cb();
    }, function () {
      let msgtext2 = '';
      let msgtext = '';

      async.eachSeries(currentCancelledOrders, function (order, cb) {
        (async () => {
          if (cancelledOrders_fyers.indexOf(order.order_id) == -1) {
            msgtext2 += `${order.placed_by} - ${order.message == 'EXCH:The Price is out of the current execution range'?'Option Freeze':order.message}\n`;
            cancelledOrders_fyers.push(order.order_id);
            setTimeout(function () {
              FyersAccount.place_order(String(order.accountId), {
                "type": order.transaction_type,
                "quantity": order.quantity,
                "tradingsymbol": order.tradingsymbol
              }, function (err, order_resp) {
                console.log(order_resp);
              });
              d_sendUpdatePnl();
            }, 5000);
          }
          cb();
        })()
      }, function () {
        if (msgtext2.length > 0) {
          notify(msgtext2, 0);
        }
        fs.writeFileSync('cancelledOrders_fyers.json', JSON.stringify(cancelledOrders_fyers));
      });

      async.eachSeries(currentRejectedOrders, function (order, cb) {
        if (rejectedOrders.indexOf(order.order_id) == -1) {
          msgtext += `${order.placed_by} - ${order.tag} - ${order.status_message.indexOf('Insufficient funds') != -1?'Insufficient funds':order.status_message}\n`;
          rejectedOrders.push(order.order_id);
        } else cb();
      }, function () {
        if (msgtext.length > 0) {
          notify(msgtext, 0);
        }
      });
    });
  });
}

let d_sendUpdatePnl = debounce(sendUpdatePnl, 5000);

function init() {
  PaperTrade.getDataSource().connector.connect(function (err, db) {
    console.log('datasource connected');
    const collection = db.collection("paper-trade");
    const changeStream = collection.watch();
    changeStream.on("change", function (event) {
      if (event.fullDocument && event.fullDocument.tag) d_sendUpdatePnl();
    });
  });
}

// init();
new CronJob('0 14 9 * * 1-5', init, null, true, 'Asia/Kolkata');
new CronJob('0 30 15 * * 1-5', function () {
  setTimeout(process.exit, 6000);
}, null, true, 'Asia/Kolkata');
