const app = require('../server.js');
const Account = app.models.account;
const XtsAccount = app.models.xtsAccount;
const async = require('async');
const zerodha = require('../lib/zerodha');

async function zerodha_init(account) {
  let zapi_n = new zerodha();
  zapi_n.loadConfig(account);
  let login_resp = await zapi_n.login();
  account.lastLogin = (new Date()).toISOString().substr(0, 10);
  account.config = await zapi_n.getConfig();
  console.log(login_resp, account.config);
}

async function init() {

  let accounts = await XtsAccount.find();
  // let accounts = await Account.find();

  async.eachLimit(accounts, 5, function (account, cb) {
    // if (lotSize[account.name]) {
    // account.strategy = {
    //   'STG2': 0,
    //   'STG3': 0,
    //   'STG6': 0,
    //   'STG7': 0,
    //   'STG34': 0,
    // };

    if (account.strategy) {
      account.strategy.STG8 = 0;
    }

    // } else {
    //   console.log(account.name, 'lot not defined');
    // }
    account.save().then(_ => {
      cb();
    });
  }, function (err) {
    console.log(err);
    console.log('done');
  });

}

init();
