const fs = require('fs');
const CronJob = require("cron").CronJob;
const app = require('../server.js');
const Account = app.models.account;
const Report = app.models.report;
const XtsAccount = app.models.xtsAccount;
const Algouser = app.models.algouser;
const FyersAccount = app.models.FyersAccount;
const OrderBook = app.models.orderbook;
const async = require('async');
const Zerodha = require('../lib/zerodha');
let strategies = ['AlgoEQ', 'Index', 'Index_Old', 'Bentley', 'RollsRoyce', 'Birbal_AI', 'Casino', 'Tesla', 'TR', 'Pi', 'ITCRT', 'LX1', 'LX2', 'LX3', 'LX4', 'STG3', 'STG4', 'Chai', 'Spider', 'F2', 'ST1', 'BTS', 'BBT', 'BBT5', 'BBTn5', 'iStraddle', 'Strangle', 'mStrangle', 'nStrangle', 'uStrangle', 'LowRisk', 'mLowRisk', 'uLowRisk', 'Joker', 'Math_AI', 'Index', 'Index_Old', 'AlgoEQ', 'Bahubali', 'Birbal_AI', 'Birbal_LMT', 'Casino', 'Tesla', 'Pi', 'ITC', 'ITCRT', 'Chai', 'Spider', 'F2', 'ST1', 'S1', 'BTS', 'BBT', 'BBTn5', 'BBT5', 'Urvashi', 'Strangle', 'mStrangle', 'nStrangle', 'uStrangle', 'LowRisk', 'mLowRisk', 'uLowRisk', 'Joker', 'mStrangleT', 'uStrangleT', 'Strangle40', 'Strangle60', "STG1", "STG2", "STG3", "STG4", "STG5", "STG6", "STG7", "STG8", "STG9", "STG10", "STG11", "STG12", "STG13", "STG14", "STG15", "STG16", "STG17", "STG18", "STG19", "STG20", "STG21", "STG22", "STG23", "MTM_1", "STGL-120", "STGL-160", "Strangle240", 'Strangle2k', 'MB-2k', "MB-N700", "MB-10", "AudiB1", "AudiB2", "AudiB3", "AudiB4", "AudiN1", "AudiN2", "AudiT60", "AudiTT", "AudiTT2", "Banknifty12", "Nifty12", "Ford", "Ford2", "Ford3", 'AudiT80R', 'AudiT120R', 'AudiB80R', 'AudiB120R', 'B5', 'B4', 'T4', 'T3', 'Volvo', 'Volvo2', "TWS", "TWSn", 'V1', 'V2', 'Hedge', 'Super20', 'Honda2k'];
strategies = Array.from(new Set(strategies));

// let orders = require('./../../orders.json');
// let pnl = calculatePNL(orders);
// pnl = Object.keys(pnl).reduce((s, c) => {
//   // console.log(c, pnl[c])
//   return s += pnl[c];
// }, 0);
// console.log(pnl);

function intradayBrokerageCalc(symbol, buy_price, sell_price, qty, brokerage_obj) {
  let bp = buy_price;
  let sp = sell_price;
  // let bplan = 0.0003;
  // var brokerage_buy = ((bp * qty * bplan) > 20) ? 20 : parseFloat(parseFloat(bp * qty * bplan).toFixed(2));
  // var brokerage_sell = ((sp * qty * bplan) > 20) ? 20 : parseFloat(parseFloat(sp * qty * bplan).toFixed(2));

  // if (symbol.indexOf('BANKNIFTY') != -1) brokerage_buy = (qty / 25) * 5;
  // else if (symbol.indexOf('NIFTY') != -1) brokerage_buy = (qty / 50) * 5;
  // else brokerage_buy = 5;
  var brokerage = 20;
  // if (buy_price != 0) brokerage += brokerage_buy;
  // if (sell_price != 0) brokerage += brokerage_buy;

  var turnover = parseFloat(parseFloat((bp + sp) * qty).toFixed(2));
  let pc = sp != 0 ? sp : bp;
  var stt_total = Math.round(parseFloat(parseFloat((pc * qty) * 0.0005).toFixed(2)));
  var exc_trans_charge = parseFloat(parseFloat(0.00053 * turnover).toFixed(2));
  var cc = 0;
  var gst = parseFloat(parseFloat(0.18 * (brokerage + exc_trans_charge)).toFixed(2));
  var sebi_charges = parseFloat(parseFloat(turnover * 0.000001).toFixed(2));
  var stamp_duty = parseFloat(parseFloat(bp * qty * 0.00003).toFixed(2));
  var total_tax = parseFloat(parseFloat(brokerage + stt_total + exc_trans_charge + cc + gst + stamp_duty + sebi_charges).toFixed(2));
  var breakeven = parseFloat(parseFloat(total_tax / qty).toFixed(2));
  breakeven = isNaN(breakeven) ? 0 : breakeven
  var net_profit = parseFloat(parseFloat(((sp - bp) * qty) - total_tax).toFixed(2));

  if (typeof brokerage_obj != 'object') brokerage_obj = {};

  brokerage_obj.turnover = brokerage_obj.turnover ? brokerage_obj.turnover + turnover : turnover;
  brokerage_obj.brokerage = brokerage_obj.brokerage ? brokerage_obj.brokerage + brokerage : brokerage;
  brokerage_obj.stt_total = brokerage_obj.stt_total ? brokerage_obj.stt_total + stt_total : stt_total;
  brokerage_obj.exc_trans_charge = brokerage_obj.exc_trans_charge ? brokerage_obj.exc_trans_charge + exc_trans_charge : exc_trans_charge;
  brokerage_obj.cc = brokerage_obj.cc ? brokerage_obj.cc + cc : cc;
  brokerage_obj.gst = brokerage_obj.gst ? brokerage_obj.gst + gst : gst;
  brokerage_obj.stamp_duty = brokerage_obj.stamp_duty ? brokerage_obj.stamp_duty + stamp_duty : stamp_duty;
  brokerage_obj.sebi_charges = brokerage_obj.sebi_charges ? brokerage_obj.sebi_charges + sebi_charges : sebi_charges;
  brokerage_obj.total_tax = brokerage_obj.total_tax ? brokerage_obj.total_tax + total_tax : total_tax;

  brokerage_obj.turnover = parseFloat(brokerage_obj.turnover.toFixed(2));
  brokerage_obj.brokerage = parseFloat(brokerage_obj.brokerage.toFixed(2));
  brokerage_obj.stt_total = parseFloat(brokerage_obj.stt_total.toFixed(2));
  brokerage_obj.exc_trans_charge = parseFloat(brokerage_obj.exc_trans_charge.toFixed(2));
  brokerage_obj.cc = parseFloat(brokerage_obj.cc.toFixed(2));
  brokerage_obj.gst = parseFloat(brokerage_obj.gst.toFixed(2));
  brokerage_obj.stamp_duty = parseFloat(brokerage_obj.stamp_duty.toFixed(2));
  brokerage_obj.sebi_charges = parseFloat(brokerage_obj.sebi_charges.toFixed(2));
  brokerage_obj.total_tax = parseFloat(brokerage_obj.total_tax.toFixed(2));

  return brokerage_obj;
}

async function init() {
  let accounts = await Account.find({});

  let todayDate = new Date();
  todayDate.setHours(0);
  todayDate.setMilliseconds(0);
  todayDate.setMinutes(0);
  todayDate.setSeconds(0);

  try {
    Algouser.all_positions(function (err, data) {
      let users_report = data.map(function (account, idx) {
        let brokerage = {},
          total_m2m = 0;
        account.positions.forEach(function (position) {
          brokerage = intradayBrokerageCalc(position.tradingsymbol, position.buy_price, position.sell_price, position.sell_quantity, brokerage);
          total_m2m += position.m2m;
        });
        return {
          clientCode: account.name,
          platform: 'algo',
          algouserId: account.accountId,
          pnl: total_m2m - brokerage.total_tax,
          brokerage: brokerage,
          gross: total_m2m,
          ts: todayDate
        };
      })
      Report.create(users_report);
    });
  } catch (err) {
    console.log(err);
  }

  XtsAccount.all_positions(true, function (err, resp) {
    async.each(resp, function (account, cb) {
      let totalPNL = account.positions.reduce((total_pnl, elm) => {
        return total_pnl + parseFloat(elm.value);
      }, 0);
      // let strategyWisePNL = calculatePNL(account.orders);
      // strategyWisePNL = Object.keys(strategyWisePNL).map(c => {
      //   if (strategyWisePNL[c] != 0) {
      //     return {
      //       clientCode: account.username,
      //       xtsAccountId: String(account.accountId),
      //       platform: 'xts',
      //       strategy: c,
      //       pnl: strategyWisePNL[c],
      //       ts: todayDate
      //     };
      //   } else return false;
      // }).filter(c => c);
      // console.log('xts', strategyWisePNL);
      // Report.create(strategyWisePNL).then(cb);
      Report.create({
        clientCode: account.username,
        xtsAccountId: String(account.accountId),
        platform: 'xts',
        strategy: 'account',
        pnl: totalPNL,
        ts: todayDate
      }).then(cb);
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
        fyersAccountId: account.id,
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

  Account.all_positions(true, function (err, resp) {
    async.eachSeries(resp, function (account, cb) {
      (async () => {
        try {
          let res = await OrderBook.upsertWithWhere({
            createdAt: todayDate,
            accountId: account.accountId
          }, account);

          let positionsPnl = account.positions.reduce(function (total, position) {
            return total + position.m2m;
          }, 0);

          let strategyWisePNL = calculatePNL(account.orders);
          strategyWisePNL = Object.keys(strategyWisePNL).map(c => {
            if (strategyWisePNL[c] != 0) {
              return {
                clientCode: account.name,
                strategy: c,
                accountId: account.id,
                pnl: strategyWisePNL[c],
                pnl2: positionsPnl,
                ts: todayDate
              };
            } else return false;
          }).filter(c => c);

          let spnl = strategyWisePNL.reduce((s, a) => {
            return s + a.pnl
          }, 0);

          if (Math.abs(spnl - positionsPnl) > 10) {
            strategyWisePNL = {
              clientCode: account.name,
              strategy: 'positions',
              pnl: positionsPnl,
              ts: todayDate
            }
          }

          await Report.create(strategyWisePNL);
          // console.log(strategyWisePNL, positionsPnl);
          cb();
        } catch (err) {
          console.log('error', err);
          cb();
        }
      })();
    }, function () {
      console.log('Positions Saved!');
    });
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
                  // console.log(orders['other'][c]);
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
                  // console.log(orders['other'][c]);
                  // console.log(strategy, c, netQuantity, trade);
                  if (orders['other'][c].length == 0) delete orders['other'][c];
                }
              }
            });
          }
        }
      })
    }
  });

  // console.log(JSON.stringify(orders, null, 2));

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
          // console.log('265', c, strategy, netQuantity, avgPrice[c]);

          if (netQuantity === 0 && orders[strategy][c].length > 0) {
            avgPrice[c] = orders[strategy][c].reduce((s, a) => {
              return (a[0] == 'BUY') ? s + (a[1] * a[2]) : s + (a[2] * a[1] * -1);
            }, 0);
          }

          let netQuantityOther = orders['other'][c] ? orders['other'][c].reduce((s, a) => {
            totalValue += (a[0] == 'BUY') ? (a[2] * a[1]) : (a[2] * a[1] * -1);
            return a[0] == 'BUY' ? s + a[2] : s + (a[2] * -1);
          }, 0) : 0;
          // console.log(totalValue, netQuantityOther);
          if (!avgPrice[c]) avgPrice[c] = totalValue / netQuantityOther;

          // console.log('270', c, strategy, netQuantity, netQuantityOther, avgPrice[c]);

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
            // console.log('295', c, strategy, netQuantity, netQuantityOther, avgPrice[c]);
            if (orders['other'][c].length == 0) delete orders['other'][c];
          }
        }
      })
    }
  });

  // console.log(JSON.stringify(orders, null, 2));

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
      // console.log(orders[strategy].length);
      Object.keys(orders[strategy]).map(c => {
        orders[strategy][c].forEach(trade => {
          strategyWisePNL[strategy][trade[0]] += trade[1] * trade[2];
          // console.log(strategy, c, trade[0], trade[1], trade[2])
        });
        // console.log(strategy, strategyWisePNL[strategy]);
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