const CronJob = require("cron").CronJob;
var async = require('async');
var notify = require('../lib/notify');
var fs = require('fs');
let app, Report, Account, XtsAccount, Zerodha = require('../lib/zerodha.js');

function roundOff(amount) {
  return String(parseInt(amount)).replace(/(\d)(?=(\d\d)+\d$)/g, "$1,")
}
async function init() {
  app = require('../server.js');
  Account = app.models.account;
  Report = app.models.report;
  XtsAccount = app.models.xtsAccount;

  let accounts = await Account.find();
  let xtsAccounts = await XtsAccount.find();

  async.mapLimit(xtsAccounts, 3, function (xtsAccount, cb3) {
    (async () => {
      try {
        let client = await XtsAccount.loginClient(xtsAccount);
        let positions = await client.getPositions({
          dayOrNet: "DayWise"
        });
        let totalAccountPnl = positions.result.positionList.reduce((s, c) => {
          s += parseFloat(c.MTM.replace(/,/g, ''))
          return s;
        }, 0);
        let resp = {
          name: xtsAccount.name,
          fullname: xtsAccount.username,
          m2m: totalAccountPnl
        };
        cb3(null, resp);
      } catch (err) {
        console.log(err);
        cb3(null, false);
      }
    })();
  }, function (err, xtsPnl) {
    async.mapLimit(accounts, 3, function (account, cb2) {
      (async () => {
        try {
          let zapi_n = new Zerodha();
          zapi_n.loadConfig(account);
          let session = await zapi_n.checkSession();
          if (!session) {
            session = await zapi_n.login();
            account.lastLogin = (new Date()).getTime();
            account.config = await zapi_n.getConfig();
            await account.save();
          }
          let orderbook = await zapi_n.orders();
          let strategies = ['uLowRisk', 'mStrangle', 'uStrangle', 'LowRisk', 'Spider'];
          orderbook = orderbook.filter(order => {
            return (order.tag && strategies.indexOf(order.tag) != -1)
          });
          let symbols = Array.from(new Set(orderbook.map(c => c.tradingsymbol)));
          let positions = await zapi_n.positions();
          positions.day = positions.day.filter(c => c.product == 'MIS' && symbols.indexOf(c.tradingsymbol) != -1);
          let resp = {
            name: account.name,
            fullname: account.username || account.config.data.user_name,
            m2m: positions.day.reduce((s, a) => (s += a.m2m), 0)
          };
          cb2(null, resp);
        } catch (err) {
          console.log(err);
          cb2(null, false);
        }
      })();
    }, function (err, resp) {
      if (err) cb(err);
      else {
        resp = resp.concat(xtsPnl).filter(c => c).sort((a, b) => (Math.abs(b.m2m) - Math.abs(a.m2m)));
        let totalPNL = 0;

        let todayDate = new Date();
        todayDate.setHours(0);
        todayDate.setMilliseconds(0);
        todayDate.setMinutes(0);
        todayDate.setSeconds(0);

        Report.create({
          clientCode: 'optionbhai',
          strategy: 'combine',
          pnl: totalPNL,
          ts: todayDate
        });
      }
    });
  })
}

// init();
new CronJob('10 30 15 * * 1-5', init, null, true, 'Asia/Kolkata');
