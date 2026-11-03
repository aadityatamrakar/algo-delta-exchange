const CronJob = require("cron").CronJob;
const app = require('../server.js');
const OrderUpdate = app.models.OrderUpdate;
const PaperTrade = app.models.PaperTrade;

async function init() {
  PaperTrade.destroyAll().then(function () {
    console.log('Done1');
    OrderUpdate.destroyAll().then(function () {
      console.log('Done2');
      process.exit();
    });
  });
}

new CronJob('0 0 9 * * 1-5', init, null, true, 'Asia/Kolkata');
