const app = require('./server/server.js');
const PaperTrade = app.models.PaperTrade;
const fs = require('fs');
const moment = require('moment');

function download(strategy) {
  PaperTrade.find({
    where: {
      tag: strategy
    }
  }, function (err, resp) {

    var writeStream = fs.createWriteStream('./report_' + strategy + '.csv');
    writeStream.write('Tag,Timestamp,Day,Status,Exchange,TradingSymbol,IntrumentToken,OrderType,TransactionType,Quantity,Price\n');

    for (const trade of resp) {
      let cellData = [
        trade.tag,
        moment(trade.order_timestamp).add(330, 'minutes').format('YYYY-MM-DD HH:mm:ss'),
        moment(trade.order_timestamp).format('dddd'),
        trade.status,
        trade.exchange,
        trade.tradingsymbol,
        trade.instrument_token,
        trade.order_type,
        trade.transaction_type,
        trade.quantity,
        trade.average_price];
      let csv = cellData.join(',') + '\n';
      writeStream.write(csv);
    };

    writeStream.end();
    console.log('report_' + strategy + '.csv created');
  });
}

download('AudiB1');