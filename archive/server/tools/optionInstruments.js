var request = require('request');
var fs = require('fs');
const notify = require("../lib/notify.js");
let channelId = 0;

async function getInstrumentDetails(underlyings = 'NIFTY') {
  return new Promise((resolve, reject) => {
    var options = {
      'method': 'POST',
      'url': 'https://api.sensibull.com/v1/instrument_details',
      'headers': {
        'content-type': 'application/json;charset=UTF-8',
        "cookie": "access_token=free_user;",
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

async function getReq(url) {
  return new Promise((resolve, reject) => {
    var options = {
      'method': 'GET',
      'url': url,
      headers: {
        "cookie": "access_token=free_user;",
      },
      'json': true,
    };
    request(options, function (error, response) {
      if (error) throw new Error(error);
      resolve(response.body);
    });
  });
}

let futureSymbol, futureToken, futureLtp, NIFTY, ivp, ivTrend, nearestExpiry, nextWeekExpiry, monthlyExpiry, chain, futuresInstrument, currentExpiryOptions = {};
async function download(underlying = 'BANKNIFTY') {
  return new Promise(async function (resolve, reject) {
    try {
      NIFTY = await getInstrumentDetails(underlying);
      // console.log(NIFTY);
      let expiryDateSorted = Object.values(NIFTY.per_expiry_data).sort((a, b) => (a.daysToExpiry - b.daysToExpiry));
      nearestExpiry = expiryDateSorted[0].expiry;
      nextWeekExpiry = expiryDateSorted[1].expiry;
      chain = await getReq('https://api.sensibull.com/v1/instruments/' + underlying);
      ivp = NIFTY.per_expiry_data[nearestExpiry].iv_percentile;
      ivTrend = parseFloat(NIFTY.per_expiry_data[nearestExpiry].prev_iv) < NIFTY.per_expiry_data[nearestExpiry].impliedVolatility ? 'bullish' : 'bearish';

      if (typeof chain != 'object' || chain.status != true) notify('chain data not available.', channelId);
      else {
        futuresInstrument = chain.data.filter(c => (c.segment == 'NFO-FUT' || c.segment == 'BFO-FUT')).sort((a, b) => (a.expiry - b.expiry));
        if (futuresInstrument.length == 0) {
          monthlyExpiry = "";
          futureToken = 0;
          futureSymbol = "";
          futureLtp = 0;
          max_pain = 0;
        } else {
          let monthlyIdx = futuresInstrument.findIndex(c => (c.expiry.substr(0, 7) == nearestExpiry.substr(0, 7)));
          if (monthlyIdx == -1) monthlyIdx = 0;
          monthlyExpiry = futuresInstrument[monthlyIdx].expiry;
          futureToken = futuresInstrument[monthlyIdx].instrument_token;
          futureSymbol = futuresInstrument[monthlyIdx].tradingsymbol;
          futureLtp = futuresInstrument[monthlyIdx].last_price;
          max_pain = parseInt(NIFTY.per_expiry_data[monthlyExpiry].max_pain);
        }
        // notify('Options Data Ready, Current Fut: ' + futureSymbol + ' Weekly: ' + nearestExpiry + ' Monthly: ' + monthlyExpiry, channelId);
        currentExpiryOptions = chain.data.filter(c => (c.expiry == nearestExpiry)).reduce((ob, elm) => {
          ob[elm.strike + elm.instrument_type] = {
            expiry: elm.expiry,
            instrument_token: elm.instrument_token,
            instrument_type: elm.instrument_type,
            last_price: elm.last_price,
            lot_size: elm.lot_size,
            name: elm.name,
            segment: elm.segment,
            strike: elm.strike,
            tradingsymbol: elm.tradingsymbol,
          };
          return ob;
        }, {});

        nextWeekExpiryOptions = chain.data.filter(c => (c.expiry == nextWeekExpiry)).reduce((ob, elm) => {
          ob[elm.strike + elm.instrument_type] = {
            expiry: elm.expiry,
            instrument_token: elm.instrument_token,
            instrument_type: elm.instrument_type,
            last_price: elm.last_price,
            lot_size: elm.lot_size,
            name: elm.name,
            segment: elm.segment,
            strike: elm.strike,
            tradingsymbol: elm.tradingsymbol,
          };
          return ob;
        }, {});

        let allOptions = chain.data.filter(c => (c.segment == 'NFO-OPT' || c.segment == 'BFO-OPT')).map(elm => ({
          expiry: elm.expiry,
          instrument_token: elm.instrument_token,
          instrument_type: elm.instrument_type,
          last_price: elm.last_price,
          lot_size: elm.lot_size,
          name: elm.name,
          segment: elm.segment,
          strike: elm.strike,
          tradingsymbol: elm.tradingsymbol,
        }));

        let data = {
          symbol: underlying,
          options: allOptions,
          futures: futuresInstrument,
          currentFuture: {
            token: futureToken,
            symbol: futureSymbol,
            ltp: futureLtp
          },
          monthlyExpiry: monthlyExpiry,
          max_pain: parseInt(NIFTY.per_expiry_data[monthlyExpiry].max_pain),
          ivp: ivp,
          ivTrend: ivTrend,
          weeklyExpiry: nearestExpiry,
          weeklyInstruments: currentExpiryOptions,
          nextWeekInstruments: nextWeekExpiryOptions
        };
        resolve(data);
        fs.writeFileSync('optionConfig_' + underlying + '.json', JSON.stringify(data));
      }
    } catch (err) {
      console.log(err);
      reject();
    }
  })
}

async function config(underlying = 'BANKNIFTY') {
  try {
    // console.log('no download');
    let configFile = require('./../../optionConfig_' + underlying + '.json');
    return configFile;
  } catch (err) {
    console.log('yes download');
    let data = await download(underlying);
    return data;
  }
}

// new CronJob('0 17 9 * * 1-5', download, null, true, 'Asia/Kolkata');
module.exports = config;
module.exports.download = download;
// download('BANKNIFTY');
// download('SENSEX');
