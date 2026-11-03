const app = require('./server/server.js');
const Positional = app.models.positional;
const PaperTrade = app.models.PaperTrade;
const Report = app.models.report;

async function init(symbol) {
  let data = await Positional.find({
    where: {
      tradingsymbol: new RegExp(symbol),
    }
  });

  let strategies = [];
  let strategy_paper = {};

  data.forEach((order) => {
    if (!strategy_paper[order.tag]) strategy_paper[order.tag] = [];
    strategy_paper[order.tag].push(order);
  });
  strategies = Object.keys(strategy_paper);

  let strategy_positions = {};

  strategies.forEach((strategy) => {
    if (strategy_paper[strategy] && strategy_paper[strategy].length > 0) {
      strategy_positions[strategy] = {};
      strategy_paper[strategy].forEach((order) => {
        if (order.status == 'COMPLETE') {
          if (!strategy_positions[strategy][order.tradingsymbol]) {
            strategy_positions[strategy][order.tradingsymbol] = {
              "tradingsymbol": order.tradingsymbol,
              "instrument_token": order.instrument_token,
              "quantity": order.transaction_type == 'SELL' ? -1 * order.quantity : order.quantity,
              "average_price": order.average_price,
              "last_price": order.average_price,
              "m2m": 0,
              "sell_quantity": 0,
              "sell_price": 0,
              "sell_value": 0,
              "buy_quantity": 0,
              "buy_price": 0,
              "buy_value": 0,
            };

            strategy_positions[strategy][order.tradingsymbol][(order.transaction_type).toLowerCase() + "_quantity"] = order.quantity;
            strategy_positions[strategy][order.tradingsymbol][(order.transaction_type).toLowerCase() + "_price"] = order.average_price;
            strategy_positions[strategy][order.tradingsymbol][(order.transaction_type).toLowerCase() + "_value"] = order.average_price * order.quantity;
          } else {
            if (order.transaction_type == 'SELL') {
              strategy_positions[strategy][order.tradingsymbol].quantity += -1 * order.quantity;
              strategy_positions[strategy][order.tradingsymbol].sell_quantity += order.quantity;
              strategy_positions[strategy][order.tradingsymbol].sell_value += Math.round(order.quantity * order.average_price);
              strategy_positions[strategy][order.tradingsymbol].sell_price = Math.round(strategy_positions[strategy][order.tradingsymbol].sell_value / strategy_positions[strategy][order.tradingsymbol].sell_quantity * 100) / 100;
            } else {
              strategy_positions[strategy][order.tradingsymbol].quantity += order.quantity;
              strategy_positions[strategy][order.tradingsymbol].buy_quantity += order.quantity;
              strategy_positions[strategy][order.tradingsymbol].buy_value += Math.round(order.quantity * order.average_price);
              strategy_positions[strategy][order.tradingsymbol].buy_price = Math.round(strategy_positions[strategy][order.tradingsymbol].buy_value / strategy_positions[strategy][order.tradingsymbol].buy_quantity * 100) / 100;
            }
          }

          if (strategy_positions[strategy][order.tradingsymbol].quantity == 0) {
            strategy_positions[strategy][order.tradingsymbol].m2m = strategy_positions[strategy][order.tradingsymbol].sell_value - strategy_positions[strategy][order.tradingsymbol].buy_value;
          }
        }
      });
    }
  });

  return Object.keys(strategy_positions).map(strategy => ({
    accountId: strategy,
    positions: Object.values(strategy_positions[strategy]),
    total_pnl: Object.values(strategy_positions[strategy]).reduce((s, a) => {
      s += a.m2m;
      return s;
    }, 0)
  }));
};

let symbol = 'BANKNIFTY22324';
init(symbol).then(resp => {
  let todayDate = new Date();
  todayDate.setHours(0);
  todayDate.setMilliseconds(0);
  todayDate.setMinutes(0);
  todayDate.setSeconds(0);
  // Date
  todayDate.setDate(30);
  todayDate.setMonth(8);

  resp.forEach(function (c) {
    let report = {
      clientCode: c.accountId,
      platform: 'paper',
      strategy: c.accountId,
      pnl: parseInt(c.total_pnl),
      ts: todayDate
    };

    console.log(report);
    // Report.create(report, function () {
    //   console.log(report.clientCode + ' saved');

    //   Positional.destroyAll({
    //     tradingsymbol: new RegExp(symbol),
    //   }, function () {
    //     console.log('Trades Deleted');
    //   });
    // });
  })
});


function saveReport(strategy, pnl) {
  let todayDate = new Date();
  todayDate.setHours(0);
  todayDate.setMilliseconds(0);
  todayDate.setMinutes(0);
  todayDate.setSeconds(0);

  let report = {
    clientCode: strategy,
    platform: 'paper',
    strategy: strategy,
    pnl: parseInt(pnl),
    ts: todayDate
  };

  Report.create(report, function () {
    console.log(report.clientCode + ' saved');
    
    Positional.destroyAll({
      tag: strategy,
    }, function () {
      console.log('Trades Deleted');
    });
  });
}
// saveReport('HDFC_SPD', 128040);
