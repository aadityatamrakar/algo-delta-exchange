'use strict';

const CronJob = require("cron").CronJob;

module.exports = function (app) {
  async function resetAcc() {
    console.log('reseting lot size');
    let Account = app.models.account;
    let accounts = await Account.find();
    for (let i = 0; i < accounts.length; i++) {
      if (accounts[i].bkp_strategy) {
        console.log('account name: ' + accounts[i].name);
        accounts[i].strategy = JSON.parse(JSON.stringify(accounts[i].bkp_strategy));
        accounts[i].bkp_strategy = false;
        await accounts[i].save();
      }
    }
  }
  async function resetAccXts() {
    console.log('reseting lot size XTS');
    let Account = app.models.xtsAccount;
    let accounts = await Account.find();
    for (let i = 0; i < accounts.length; i++) {
      if (accounts[i].bkp_strategy) {
        console.log('xts account name: ' + accounts[i].name);
        accounts[i].strategy = JSON.parse(JSON.stringify(accounts[i].bkp_strategy));
        accounts[i].bkp_strategy = false;
        await accounts[i].save();
      }
    }
  }
  async function resetAccFyers() {
    console.log('reseting lot size XTS');
    let Account = app.models.FyersAccount;
    let accounts = await Account.find();
    for (let i = 0; i < accounts.length; i++) {
      if (accounts[i].bkp_strategy) {
        console.log('fyers account name: ' + accounts[i].name);
        accounts[i].strategy = JSON.parse(JSON.stringify(accounts[i].bkp_strategy));
        accounts[i].bkp_strategy = false;
        await accounts[i].save();
      }
    }
  }

  app.on('started', function () {
    if (require.main.filename.replace(require.main.path + '/', '') === 'server.js') {
      // new CronJob('0 35 15 * * 1-5', resetAcc, null, true, 'Asia/Kolkata');
      // new CronJob('0 35 15 * * 1-5', resetAccXts, null, true, 'Asia/Kolkata');
      // new CronJob('0 35 15 * * 1-5', resetAccFyers, null, true, 'Asia/Kolkata');
      // new CronJob('0 0 8 * * 1-5', resetAcc, null, true, 'Asia/Kolkata');
      // new CronJob('0 0 8 * * 1-5', resetAccXts, null, true, 'Asia/Kolkata');
      // new CronJob('0 0 8 * * 1-5', resetAccFyers, null, true, 'Asia/Kolkata');
    }
  });
};
