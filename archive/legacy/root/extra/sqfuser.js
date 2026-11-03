let app = require('../server/server.js'),
  Account = app.models.account,
  Papertrade = app.models.PaperTrade,
  Algouser = app.models.algouser,
  Algopaper = app.models.algopaper,
  zerodha = require('../server/lib/zerodha.js');

async function closePaperTrading() {
  Algouser.all_positions(0, function (err, data) {
    let userId = data.accountId;
    console.log(data);
    if (data.positions) {
      data.positions = data.positions.filter((pos) => (pos.quantity != 0));
      data.positions.forEach(async (order) => {
        Algopaper.trackOrder(userId, {
          instrument_token: order.instrument_token,
          tradingsymbol: order.tradingsymbol,
          lot_size: Math.abs(order.quantity)
        }, (order.quantity > 0 ? 'SELL' : 'BUY'), 'SQF', 0);
      });
    }
    cb(null, {
      status: true
    });
  });
}

closePaperTrading();
