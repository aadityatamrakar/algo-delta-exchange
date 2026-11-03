'use strict';
const app = require('../server.js');
const XtsAccount = app.models.xtsAccount;
const PaperTrade = app.models.PaperTrade;
const debounce = require('./../lib/debounce');
const async = require('async');
const notify = require('./../lib/notify');
const CronJob = require("cron").CronJob;

let rejectedOrders = [];

function sendUpdatePnl() {
  XtsAccount.all_positions(true, function (err, resp) {
    let currentRejectedOrders = [];
    async.eachLimit(resp, 5, function (accountPosition, cb) {
      let accountRejectedOrders = accountPosition.orders.filter(c => c.status.toUpperCase() === 'REJECTED' || c.status.toUpperCase() == 'CANCELLED');
      //   console.log(accountRejectedOrders);
      currentRejectedOrders.push(...accountRejectedOrders);
      cb();
    }, function () {
      let msgtext = '';
      //   console.log(currentRejectedOrders);
      async.eachSeries(currentRejectedOrders, function (order, cb) {
        if (rejectedOrders.indexOf(order.order_id) == -1) {
          msgtext += `${order.placed_by} - ${order.tag} - ${order.status_message}\n`;
          rejectedOrders.push(order.order_id);
          cb();
        } else cb();
      }, function () {
        if (msgtext.length > 0) {
          notify(msgtext, 0);
        }
      });
    });
  });
}

let d_sendUpdatePnl = debounce(sendUpdatePnl, 30000);

function init() {
  PaperTrade.getDataSource().connector.connect(function (err, db) {
    console.log('datasource connected');
    const collection = db.collection("paper-trade");
    const changeStream = collection.watch();
    changeStream.on("change", function (event) {
      if (event.fullDocument && event.fullDocument.tag && event.fullDocument.tag != 'SOBU') d_sendUpdatePnl();
    });
  });
}

// init();
new CronJob('0 14 9 * * 1-5', init, null, true, 'Asia/Kolkata');
new CronJob('0 30 15 * * 1-5', function () {
  setTimeout(process.exit, 6000);
}, null, true, 'Asia/Kolkata');
