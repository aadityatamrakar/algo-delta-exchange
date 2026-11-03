const fs = require('fs');
const CronJob = require("cron").CronJob;
const app = require('../server.js');
const Account = app.models.account;
const Report = app.models.report;
const XtsAccount = app.models.xtsAccount;
const FyersAccount = app.models.FyersAccount;
const async = require('async');
const Zerodha = require('../lib/zerodha');
let strategies = ["STG1", "STG2", "STG3", "STG4", "STG5", "STG6", "STG7", "STG8", "STG9", "STG10", "STG11", "STG12", "STG13", "STG14", "STG15", "STG16", "STG17", "STG18", "STG19", "STG20", "STG21", "STG22", "STG23"];

// let orders = require('./../../orders.json');
// let pnl = calculatePNL(orders);
// pnl = Object.keys(pnl).reduce((s, c) => {
//   console.log(c, pnl[c])
//   return s += pnl[c];
// }, 0);
// console.log(pnl);

async function init() {
  let accounts = await Account.find({});

  let todayDate = new Date();
  todayDate.setHours(0);
  todayDate.setMilliseconds(0);
  todayDate.setMinutes(0);
  todayDate.setSeconds(0);

  XtsAccount.all_positions(true, function (err, resp) {
    async.each(resp, function (account, cb) {
      let strategyWisePNL = calculatePNL(account.orders);
      strategyWisePNL = Object.keys(strategyWisePNL).map(c => {
        if (strategyWisePNL[c] != 0) {
          return {
            clientCode: account.name,
            platform: 'xts',
            strategy: c,
            pnl: strategyWisePNL[c],
            ts: todayDate
          };
        } else return false;
      }).filter(c => c);
      Report.create(strategyWisePNL).then(cb);
    }, function () {
      console.log('xts done');
    });
  });

  FyersAccount.all_positions(true, function (err, resp) {
    async.each(resp, function (account, cb) {
      let total_m2m = account.positions.reduce((s, a) => {
        s += a.m2m;
        return s;
      }, 0);
      let record = {
        clientCode: account.name,
        platform: 'fyers',
        strategy: 'all',
        pnl: total_m2m,
        ts: todayDate
      };
      Report.create(record).then(cb);
    }, function () {
      console.log('fyers done');
    });
  });

  async.mapLimit(accounts, 3, function (account, cb) {
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
        let strategyWisePNL = calculatePNL(orderbook);

        strategyWisePNL = Object.keys(strategyWisePNL).map(c => {
          if (strategyWisePNL[c] != 0) {
            return {
              clientCode: account.name,
              strategy: c,
              pnl: strategyWisePNL[c],
              ts: todayDate
            };
          } else return false;
        }).filter(c => c);

        await Report.create(strategyWisePNL);
        cb();
      } catch (err) {
        console.log(err);
        cb();
      }
    })()
  }, function () {
    console.log('zerodha done');
  });
}

function calculatePNL(orders) {
  orders = orders.filter(c => (c.status == 'COMPLETE' || c.status == 'Filled'));
  orders = orders.reduce((s, a) => {
    let tmp = {
      trade_type: a.transaction_type.toUpperCase(),
      value: a.average_price,
      quantity: a.quantity,
      tradingsymbol: a.tradingsymbol,
    };

    if (strategies.indexOf(a.tag) != -1) {
      if (!s[a.tag]) s[a.tag] = {};
      if (!s[a.tag][tmp.tradingsymbol]) s[a.tag][tmp.tradingsymbol] = [];
      s[a.tag][tmp.tradingsymbol].push([tmp.trade_type, tmp.value, tmp.quantity]);
    } else {
      if (!s['other'][tmp.tradingsymbol]) s['other'][tmp.tradingsymbol] = [];
      s['other'][tmp.tradingsymbol].push([tmp.trade_type, tmp.value, tmp.quantity]);
    }

    return s;
  }, {
    other: {}
  });

  // console.log(JSON.stringify(orders, null, 2));

  strategies.forEach((strategy) => {
    if (orders[strategy]) {
      Object.keys(orders[strategy]).map(c => {
        if (orders[strategy][c]) {

          let netQuantityAll = orders[strategy][c].reduce((s, a) => {
            return a[0] == 'BUY' ? s + a[2] : s + (a[2] * -1);
          }, 0);

          if (netQuantityAll != 0) {

            orders[strategy][c].forEach((trade) => {
              let netQuantity = trade[0] == 'BUY' ? trade[2] : trade[2] * -1;
              // console.log(strategy, c, netQuantity, trade);
              if (netQuantity != 0) {
                if (orders['other'][c]) {
                  orders['other'][c] = orders['other'][c].map(a => {
                    let useQuantity = Math.abs(netQuantity);
                    if (netQuantity > 0 && a[0] == 'SELL' && a[2] == Math.abs(netQuantity)) {
                      orders[strategy][c].push([a[0], a[1], Math.abs(netQuantity)]);
                      a[2] -= Math.abs(netQuantity);
                      netQuantity -= useQuantity;
                    }
                    if (netQuantity < 0 && a[0] == 'BUY' && a[2] == Math.abs(netQuantity)) {
                      orders[strategy][c].push([a[0], a[1], Math.abs(netQuantity)]);
                      a[2] -= Math.abs(netQuantity);
                      netQuantity += useQuantity;
                    }
                    return a[2] != 0 ? a : false;
                  }).filter(f => f);
                  if (orders['other'][c].length == 0) delete orders['other'][c];
                }
              }
            });
          }
        }
      })
    }
  });

  // console.log('');

  let avgPrice = {};
  strategies.forEach((strategy) => {
    if (orders[strategy]) {
      Object.keys(orders[strategy]).map(c => {
        if (orders[strategy][c]) {
          let netQuantity = orders[strategy][c].reduce((s, a) => {
            return a[0] == 'BUY' ? s + a[2] : s + (a[2] * -1);
          }, 0);
          // let avgPrice = 0;
          let totalValue = 0;

          let netQuantityOther = orders['other'][c] ? orders['other'][c].reduce((s, a) => {
            totalValue += (a[0] == 'BUY') ? (a[2] * a[1]) : (a[2] * a[1] * -1);
            return a[0] == 'BUY' ? s + a[2] : s + (a[2] * -1);
          }, 0) : 0;

          if (!avgPrice[c]) avgPrice[c] = totalValue / netQuantityOther;

          // console.log(c, strategy, netQuantity, netQuantityOther, avgPrice[c]);

          if (netQuantityOther != 0) {
            orders['other'][c] = orders['other'][c].map(a => {
              let useQuantity = Math.abs(netQuantity);
              if (netQuantity > 0 && a[0] == 'SELL') {
                orders[strategy][c].push([a[0], avgPrice[c], Math.abs(netQuantity)]);
                a[2] -= Math.abs(netQuantity);
                netQuantity -= useQuantity;
                netQuantityOther -= useQuantity;
                if (a[2] < 0) a[0] = 'BUY';
              }
              if (netQuantity < 0 && a[0] == 'BUY') {
                orders[strategy][c].push([a[0], avgPrice[c], Math.abs(netQuantity)]);
                a[2] -= Math.abs(netQuantity);
                netQuantity += useQuantity;
                netQuantityOther += useQuantity;
                if (a[2] < 0) a[0] = 'SELL';
              }
              return a[2] != 0 ? a : false;
            }).filter(f => f);
            if (orders['other'][c].length == 0) delete orders['other'][c];
          }
        }
      })
    }
  });

  // console.log('');
  // fs.writeFileSync('calc.json', JSON.stringify(orders));

  if (Object.values(orders['other']).length == 0) delete orders['other'];

  let strategyWisePNL = {};
  strategies.forEach((strategy) => {
    if (!strategyWisePNL[strategy]) strategyWisePNL[strategy] = {
      BUY: 0,
      SELL: 0
    };
    if (orders[strategy]) {
      // console.log(orders[strategy]);
      Object.keys(orders[strategy]).map(c => {
        if (orders[strategy][c].length % 2 == 0) {
          orders[strategy][c].forEach(trade => {
            strategyWisePNL[strategy][trade[0]] += trade[1] * trade[2];
            // console.log(strategy, c, trade[0], trade[2])
          });
          // console.log(strategy, strategyWisePNL[strategy]);
        }
      });

      // console.log(strategyWisePNL[strategy]);

      strategyWisePNL[strategy] = Math.round(strategyWisePNL[strategy].SELL - strategyWisePNL[strategy].BUY);
    } else {
      strategyWisePNL[strategy] = 0;
    }
  });

  return strategyWisePNL;
}

// init();
new CronJob('10 30 15 * * 1-5', init, null, true, 'Asia/Kolkata');
