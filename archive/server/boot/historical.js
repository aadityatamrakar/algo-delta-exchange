const fs = require('fs');
const async = require('async');

module.exports = function (app) {
  var router = app.loopback.Router();

  function parseData(stock, data) {
    if (data.length === 0) return [];
    else {
      data = data[0].data;
      data = data.map((d) => {
        return {
          date: d.mTIMESTAMP,
          symbol: d.CH_SYMBOL,
          open: d.CH_OPENING_PRICE,
          high: d.CH_TRADE_HIGH_PRICE,
          low: d.CH_TRADE_LOW_PRICE,
          close: d.CH_CLOSING_PRICE,
          vwap: d.VWAP,
          trades: d.CH_TOTAL_TRADES,
          turnover: d.CH_TOT_TRADED_VAL,
          qty: d.CH_TOT_TRADED_QTY,
          year_high: d.CH_52WEEK_HIGH_PRICE,
          year_low: d.CH_52WEEK_LOW
        };
      });
    }
    return data;
  }

  router.get('/stocks_sme_data', (req, res) => {
    fs.readdir('./historical', (err, files) => {
      if (err) {
        return res
          .status(500)
          .send(err);
      }

      let data = [];
      async.eachLimit(files, 5, (file, callback) => {
        let stockData = JSON.parse(fs.readFileSync(`./historical/${file}`));
        try {
          data = data.concat(parseData(file.split('.')[0], stockData));
        } catch (e) {
          console.log(e);
        }
        callback();
      }, (err) => {
        if (err) {
          return res
            .status(500)
            .send(err);
        }
        res.send(data);
      });
    });
  });

  app.use(router);
}
