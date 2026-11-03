const CronJob = require("cron").CronJob;
const kiteTicker = require('../lib/KiteTicker');
const optionConfig = require('./optionInstruments');
let fs = require('fs');

let liveFeed;
const public_token = false;
async function ticker(subs) {
  liveFeed = new kiteTicker({
    api_key: 'kitefront',
    access_token: public_token
  });
  liveFeed.connect();
  liveFeed.on("ticks", checkTicks);
  liveFeed.on("connect", function () {
    console.log('Live Feed Connected');
    console.log('subscribing', subs);
    liveFeed.subscribe(subs);
    liveFeed.setMode(liveFeed.modeFull, subs);
  });
}

let futureToken, currentExpiryOptions, datafeed;
async function init() {
  let m = (new Date()).getTime();
  datafeed = fs.createWriteStream('DF_' + m + '.txt', 'utf8');
  let optionData = await optionConfig();
  futureToken = optionData.currentFuture.token;
  currentExpiryOptions = optionData.weeklyInstruments;
  let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);
  ticker([futureToken, ...optionTokens]);
}

async function checkTicks(ticks) {
  ticks.forEach(async tick => {
    let rowTxt = [tick.instrument_token, tick.last_price, tick.last_quantity, tick.average_price, tick.volume, tick.buy_quantity, tick.sell_quantity, new Date(tick.last_trade_time).getTime(), new Date(tick.timestamp).getTime(), tick.oi, tick.oi_day_high, tick.oi_day_low, tick.depth.buy[0].quantity, tick.depth.buy[0].price, tick.depth.buy[0].orders, tick.depth.buy[1].quantity, tick.depth.buy[1].price, tick.depth.buy[1].orders, tick.depth.buy[2].quantity, tick.depth.buy[2].price, tick.depth.buy[2].orders, tick.depth.buy[3].quantity, tick.depth.buy[3].price, tick.depth.buy[3].orders, tick.depth.buy[4].quantity, tick.depth.buy[4].price, tick.depth.buy[4].orders, tick.depth.sell[0].quantity, tick.depth.sell[0].price, tick.depth.sell[0].orders, tick.depth.sell[1].quantity, tick.depth.sell[1].price, tick.depth.sell[1].orders, tick.depth.sell[2].quantity, tick.depth.sell[2].price, tick.depth.sell[2].orders, tick.depth.sell[3].quantity, tick.depth.sell[3].price, tick.depth.sell[3].orders, tick.depth.sell[4].quantity, tick.depth.sell[4].price, tick.depth.sell[4].orders];
    datafeed.write(rowTxt.join(',') + "\n");
  });
}

// init();
new CronJob('0 14 9 * * 1-5', init, null, true, 'Asia/Kolkata');
new CronJob('1 30 15 * * 1-5', process.exit, null, true, 'Asia/Kolkata');