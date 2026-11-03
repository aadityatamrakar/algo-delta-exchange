const CronJob = require("cron").CronJob;
const moment = require("moment");
const app = require('../server.js');
const Report = app.models.report;
const XtsAccount = app.models.xtsAccount;
const OrderBook = app.models.orderbook;
const async = require('async');

async function init() {
  let todayDate = moment().minute(0).hour(0).second(0).millisecond(0).toDate();

  XtsAccount.all_positions(true, function (err, resp) {
    async.eachSeries(resp, function (account, cb) {
      (async () => {
        try {
          let res = await OrderBook.upsertWithWhere({
            createdAt: todayDate,
            accountId: account.accountId
          }, account);
          // console.log(res);
          let pnlReport = {
            clientCode: account.name,
            platform: 'xts',
            strategy: 'all',
            pnl: 0,
            ts: todayDate
          };
          pnlReport.pnl = account.positions.reduce(function (total, position) {
            return total + position.m2m;
          }, 0);
          await Report.create(pnlReport);
          cb();
        } catch (err) {
          console.log('error', err);
          cb();
        }
      })();
    }, function () {
      console.log('Positions Saved!');
      setTimeout(process.exit, 10000);
    });
  });
}

// setTimeout(init, 10000);
new CronJob('0 35 15 * * 1-6', init, null, true, 'Asia/Kolkata');
