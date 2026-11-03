const CronJob = require("cron").CronJob;
var request = require('request');
var fs = require('fs');
var async = require('async');
var s3upload = require('./../lib/s3upload');

// const app = require('./../server.js');
// const InstrumentsDb = app.models.instrument;

let MCX_Symbols = [];


async function getReq(url) {
  return new Promise((resolve, reject) => {
    var options = {
      'method': 'GET',
      'url': url,
      'json': true,
    };
    request(options, function (error, response) {
      if (error) throw new Error(error);
      resolve(response.body);
    });
  });
}

async function instruments() {
  return await getReq('https://api.sensibull.com/v1/instrument_details');
}

async function getOptionChain(underlying = 'NIFTY') {
  // return await getReq('https://api.sensibull.com/v1/option_chain_v2/' + underlying);
  return await getReq('https://api.sensibull.com/v1/instruments/' + underlying);
}

async function getInstrumentMeta(underlyings = ['NIFTY']) {
  return await getReq('https://api.sensibull.com/v1/instrument_metacache/2');
}

async function getInstrumentDetails(underlyings = 'NIFTY') {
  return new Promise((resolve, reject) => {
    var options = {
      'method': 'POST',
      'url': 'https://api.sensibull.com/v1/instrument_details',
      'headers': {
        'content-type': 'application/json;charset=UTF-8',
      },
      json: true,
      body: {
        underlyings: [underlyings]
      }
    };
    request(options, function (error, response) {
      if (error) throw new Error(error);
      resolve(JSON.parse(response.body[underlyings]));
    });
  })
}

async function analyseNifty(underlying, expiry) {
  return new Promise(async (resolve, reject) => {
    try {
      let futuresData = await getInstrumentDetails(underlying);

      resp = await getOptionChain(underlying);
      // console.log(resp);
      let range = 500;
      if (underlying == 'BANKNIFTY') {
        range = 1000;
      }

      optionStrikes = resp.data
        .map(elm => {
          elm.type = elm.instrument_type;
          return elm;
        })
        .filter(elm => (elm.expiry == expiry && elm.strike > (futuresData.last_price - range) && elm.strike < (futuresData.last_price + range)))
        .sort((a, b) => {
          return b.strke - a.strke;
        });

      resolve({
        status: true,
        data: {
          futures: futuresData,
          options: optionStrikes
        }
      });
    } catch (err) {
      console.log(err);
      resolve({
        status: false,
        error: err
      })
    }
  })
}

let watchlist = [
  "NIFTY",
  "BANKNIFTY",
  "ADANIPORTS",
  "ASIANPAINT",
  "AXISBANK",
  "BAJAJ-AUTO",
  "BAJAJFINSV",
  "BAJFINANCE",
  "BHARTIARTL",
  "BPCL",
  "BRITANNIA",
  "CIPLA",
  "COALINDIA",
  "DIVISLAB",
  "DRREDDY",
  "EICHERMOT",
  "GAIL",
  "GRASIM",
  "HCLTECH",
  "HDFC",
  "HDFCBANK",
  "HDFCLIFE",
  "HEROMOTOCO",
  "HINDALCO",
  "HINDUNILVR",
  "ICICIBANK",
  "INDUSINDBK",
  "INFY",
  "IOC",
  "ITC",
  "JSWSTEEL",
  "KOTAKBANK",
  "LT",
  "M&M",
  "MARUTI",
  "NESTLEIND",
  "NTPC",
  "ONGC",
  "POWERGRID",
  "RELIANCE",
  "SBILIFE",
  "SBIN",
  "SHREECEM",
  "SUNPHARMA",
  "TATAMOTORS",
  "TATASTEEL",
  "TCS",
  "TECHM",
  "TITAN",
  "ULTRACEMCO",
  "UPL",
  "WIPRO"
];

async function updateData() {

  let stocks = await instruments();

  // MCX_Symbols.forEach(symbol => {
  //   stocks.data[symbol.symbol] = symbol;
  // });

  stocks = Object.keys(stocks.data).map(k => {
    let c = stocks.data[k];
    c.symbol = k;
    c.sno = watchlist.indexOf(k) == -1 ? 999 : watchlist.indexOf(k);

    if (c.per_expiry_data && Object.values(c.per_expiry_data).length > 0) {
      c.future = Object.values(c.per_expiry_data).sort((a, b) => (a.daysToExpiry - b.daysToExpiry))[0];
    } else c.future = false;

    if (c.symbol.indexOf('NIFTY') != -1) {
      c.future = Object.values(c.per_expiry_data).filter(c => (c.future_instrument_token != 0)).sort((a, b) => (a.daysToExpiry - b.daysToExpiry))[0];
      c.instrument_token = c.future.future_instrument_token;
      c.close_price = c.future.future_close_price;
      c.last_price = c.future.futurePrice;
      // return c;
    }
    c.future.max_pain = parseInt(Math.round(c.future.max_pain));
    delete c.per_expiry_data;

    if (typeof c.tickSize == 'undefined') c.tickSize = 1;

    if (watchlist.indexOf(c.symbol) == -1) return false;
    else return c;
  }).filter(c => c);

  // async.eachLimit(stocks, 10, function (stock, cb) {
  //   InstrumentsDb.upsertWithWhere({
  //     symbol: stock.symbol
  //   }, stock, cb);
  // }, function (err) {
  //   console.log('asd');
  // });

  fs.writeFileSync(__dirname + '/../../build/data/marketwatch.json', JSON.stringify(stocks));
  s3upload(__dirname + '/../../build/data/marketwatch.json', 'application/json', true, 'data/marketwatch.json', 'cdn.algomaker.in');
}


// updateData();
new CronJob('0 15 9 * * 1-5', function () {
  new CronJob('0 * * * * 1-5', updateData, null, true, 'Asia/Kolkata');
}, null, true, 'Asia/Kolkata');
new CronJob('0 31 14 * * 1-5', function () {
  process.exit();
}, null, true, 'Asia/Kolkata');
