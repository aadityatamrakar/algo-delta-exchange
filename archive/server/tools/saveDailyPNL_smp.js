const fs = require('fs');
const CronJob = require("cron").CronJob;
const app = require('../server.js');
const Report = app.models.report;
const XtsAccount = app.models.xtsAccount;
const async = require('async');
let strategies = ["Lion_0020", "JK_0020", "Nifty_S_1789", "STGL_P_2203", "Cheetah_2203", "Cheetah_B1_2117", "Cheetah_BT_2117", "Lion_0042", "Lion_2204", "Lion_1789", "Cheetah_0042", "Cheetah_1963", "Cheetah_1910", "Cheetah_2204", "Cheetah_1911"];

async function init() {
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
