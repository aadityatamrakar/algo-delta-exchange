const kiteTicker = require('./server/lib/KiteTicker');
const optionConfig = require('./server/tools/optionInstruments');
let async = require('async');
let fs = require('fs');
let moment = require('moment');

const {
  InfluxDB,
  Point
} = require('@influxdata/influxdb-client');
let {
  b76_ivol
} = require('./server/lib/option-pricing');

const io = require("socket.io")({
  // path: "/iv_data",
  serveClient: false,
});
const server = require("https").createServer(function (req, res) {
  fs.readFile('./dash.html', function (err, data) {
    if (err) {
      res.writeHead(404);
      res.end(JSON.stringify(err));
      return;
    }
    res.writeHead(200);
    res.end(data);
  });
});

io.attach(server, {
  pingInterval: 10000,
  pingTimeout: 5000,
  cookie: false
});

server.listen(443);

// const org = 'support@algomaker.in';
// const bucket = 'banknifty';
// const client = new InfluxDB({
//   url: 'https://eu-central-1-1.aws.cloud2.influxdata.com',
//   token: 'sakPqs82XvMqv4hfs_2TMNmYlhlrftFe_WRTxopQ_D2Yt77HyrG5M3V7na723cXsbU63eyEwFBn1wwoxsu5UJQ=='
// });
// const writeApi = client.getWriteApi(org, bucket);

let m = (new Date()).getTime();
// let txtFile = fs.createWriteStream(m + '.txt', 'utf8');
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
    // console.log('subscribing', subs);
    liveFeed.subscribe(subs);
    liveFeed.setMode(liveFeed.modeFull, subs);
  });
}

let indexToken, futureToken, futureSymbol, currentExpiryOptions, zapi, timestamp, callOptions, putOptions;
async function init() {
  let optionData = await optionConfig.download();
  futureToken = optionData.currentFuture.token;
  futureSymbol = optionData.currentFuture.symbol;
  indexToken = 260105;
  currentExpiryOptions = optionData.weeklyInstruments;
  callOptions = Object.values(currentExpiryOptions).filter(c => c.instrument_type == 'CE');
  putOptions = Object.values(currentExpiryOptions).filter(c => c.instrument_type == 'PE');
  let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);
  ticker([futureToken, indexToken, ...optionTokens]);
}

let futurePrice = 0,
  indexPrice = 0,
  ticksCache = {},
  call_summary, put_summary,
  tickHistory = {},
  tte = moment().day(4).hour(15).minute(30).utcOffset('+05:30');

io.on("connection", (socket) => {
  setTimeout(function () {
    socket.emit('history', Object.values(tickHistory));
  }, 2000);
});
async function checkTicks(ticks) {
  ticks = ticks.reduce(function (ob, el) {
    ob[el.instrument_token] = el;
    return ob;
  }, {});

  Object.assign(ticksCache, ticks);

  call_summary = callOptions.reduce((s, opt) => {
    if (ticksCache[opt.instrument_token]) {
      s.vol += ticksCache[opt.instrument_token].volume;
      s.oi += ticksCache[opt.instrument_token].oi;
      s.oi_high += ticksCache[opt.instrument_token].oi_day_high;
      s.oi_low += ticksCache[opt.instrument_token].oi_day_low;
      s.buy_quantity += ticksCache[opt.instrument_token].buy_quantity;
      s.sell_quantity += ticksCache[opt.instrument_token].sell_quantity;
    }
    return s;
  }, {
    oi: 25,
    vol: 0,
    oi_high: 0,
    oi_low: 0,
    buy_quantity: 0,
    sell_quantity: 0,
  });

  put_summary = putOptions.reduce((s, opt) => {
    if (ticksCache[opt.instrument_token]) {
      s.vol += ticksCache[opt.instrument_token].volume;
      s.oi += ticksCache[opt.instrument_token].oi;
      s.oi_high += ticksCache[opt.instrument_token].oi_day_high;
      s.oi_low += ticksCache[opt.instrument_token].oi_day_low;
      s.buy_quantity += ticksCache[opt.instrument_token].buy_quantity;
      s.sell_quantity += ticksCache[opt.instrument_token].sell_quantity;
    }
    return s;
  }, {
    oi: 25,
    vol: 0,
    oi_high: 0,
    oi_low: 0,
    buy_quantity: 0,
    sell_quantity: 0,
  });

  indexPrice = _TP(indexToken);
  futurePrice = _TP(futureToken);
  ATM_strike = Math.round(indexPrice / 100) * 100;

  let iv_tick = {
    'index': indexPrice,
    'future': futurePrice,
    'atm_strike': ATM_strike,
    'atm_ce_price': _SP(ATM_strike + 'CE'),
    'atm_pe_price': _SP(ATM_strike + 'PE'),
    'atm_ce_vol': getVol(ATM_strike, 'C'),
    'atm_pe_vol': getVol(ATM_strike, 'P'),
    'pcr': (Math.round((call_summary.oi / put_summary.oi) * 100) / 100),
    'ce_buy_quantity': call_summary.buy_quantity,
    'ce_sell_quantity': call_summary.sell_quantity,
    'pe_buy_quantity': put_summary.buy_quantity,
    'pe_sell_quantity': put_summary.sell_quantity,
    'ce_oi': call_summary.oi,
    'pe_oi': put_summary.oi,
    'ce_oi_high': call_summary.oi_high,
    'pe_oi_high': put_summary.oi_high,
    'ce_oi_low': call_summary.oi_low,
    'pe_oi_low': put_summary.oi_low,
    'ce_vol': call_summary.vol,
    'pe_vol': put_summary.vol
  };
  io.emit("tick", iv_tick);

  let ts = moment().millisecond(0).utsOffset('+0530').format('X');
  tickHistory[ts] = {
    time: parseInt(ts),
    index: indexPrice,
    ce_vol: iv_tick.atm_ce_vol,
    pe_vol: iv_tick.atm_pe_vol,
  };
  // const point = new Point('tick')
  //   .floatField('index', indexPrice)
  //   .floatField('future', futurePrice)
  //   .floatField('atm_strike', ATM_strike)
  //   .floatField('atm_ce_price', _SP(ATM_strike + 'CE'))
  //   .floatField('atm_pe_price', _SP(ATM_strike + 'PE'))
  //   .floatField('atm_ce_vol', getVol(ATM_strike, 'C'))
  //   .floatField('atm_pe_vol', getVol(ATM_strike, 'P'))
  //   .floatField('pcr', (Math.round((call_summary.oi / put_summary.oi) * 100) / 100))
  //   .floatField('ce_buy_quantity', call_summary.buy_quantity)
  //   .floatField('ce_sell_quantity', call_summary.sell_quantity)
  //   .floatField('pe_buy_quantity', put_summary.buy_quantity)
  //   .floatField('pe_sell_quantity', put_summary.sell_quantity)
  //   .floatField('ce_oi', call_summary.oi)
  //   .floatField('pe_oi', put_summary.oi)
  //   .floatField('ce_oi_high', call_summary.oi_high)
  //   .floatField('pe_oi_high', put_summary.oi_high)
  //   .floatField('ce_oi_low', call_summary.oi_low)
  //   .floatField('pe_oi_low', put_summary.oi_low)
  //   .floatField('ce_vol', call_summary.vol)
  //   .floatField('pe_vol', put_summary.vol)
  // writeApi.writePoint(point);
  // console.log(point);
}

function getVol(strike, type) {
  let dte = (tte.diff(moment(), 'minutes') / 1440);
  let underlying_price = _TP(indexToken);

  let time_to_expiry = dte / 365;
  let risk_free_interest = 3.5;
  let price;

  if (type == 'C') price = _SP(strike + 'CE');
  else price = _SP(strike + 'PE');


  return Math.round(10000 * b76_ivol(type, underlying_price, strike, time_to_expiry, risk_free_interest, price)) / 100;
}

function sum(ar) {
  return ar.reduce((s, a) => (s += a, s), 0);
}

function roundOff(price) {
  return Math.round(price * 100) / 100;
}

function _TP(token) {
  return ticksCache[token].last_price;
}

function _SP(strike) {
  return Math.round(((ticksCache[currentExpiryOptions[strike].instrument_token].depth.buy[0].price + ticksCache[currentExpiryOptions[strike].instrument_token].depth.sell[0].price) / 2) * 100) / 100;
}

function dummy() {
  let sample = {
    "index": 35400 + Math.round(Math.random() * 100),
    "future": 35500 + Math.round(Math.random() * 100),
    "atm_strike": 35400,
    "atm_ce_price": 363.93,
    "atm_pe_price": 253.65,
    "atm_ce_vol": (25 + (Math.random() * 2)),
    "atm_pe_vol": (20 + (Math.random() * 2)),
    "pcr": 1.59,
    "ce_buy_quantity": 6164025,
    "ce_sell_quantity": 3113000,
    "pe_buy_quantity": 7839350,
    "pe_sell_quantity": 1873200,
    "ce_oi": 18333450,
    "pe_oi": 11550975,
    "ce_oi_high": 22082725,
    "pe_oi_high": 15474325,
    "ce_oi_low": 13750975,
    "pe_oi_low": 8764450,
    "ce_vol": 190142850,
    "pe_vol": 151671350
  };
  io.emit('tick', sample);
}

// init();
// setInterval(dummy, 1000);

const CronJob = require("cron").CronJob;
new CronJob('0 15 9 * * 1-5', init, null, true, 'Asia/Kolkata');
new CronJob('0 30 15 * * 1-5', function () {
  process.exit();
}, null, true, 'Asia/Kolkata');
