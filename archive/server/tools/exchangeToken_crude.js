const CronJob = require("cron").CronJob;
const request = require('request');
const async = require('async');
const app = require('../server.js');
const InstrumentDb = app.models.instrument;

async function getInstruments() {
  return new Promise((resolve, reject) => {
    var options = {
      'method': 'GET',
      'url': 'https://api.kite.trade/instruments',
    };
    request(options, function (error, response) {
      if (error) reject(error);
      let instruments = response.body.split('\n');
      instruments.splice(0, 1);
      resolve(instruments);
    });
  })
}

async function saveInstruments() {
  let instruments = await getInstruments();

  let bank_instruments = instruments.map(row => {
    row = row.split(',');
    if (row.length == 12) {
      return {
        instrument_token: row[0],
        exchange_token: row[1],
        tradingsymbol: row[2],
        name: row[3] ? row[3].replace(new RegExp('"', 'g'), '') : "",
        last_price: row[4],
        expiry: row[5],
        strike: row[6],
        tick_size: row[7],
        lot_size: row[8],
        instrument_type: row[9],
        segment: row[10],
        exchange: row[11]
      }
    } else return false;
  }).filter(c => c && c.name == 'CRUDEOIL');

  instruments = [...bank_instruments];
  async.eachLimit(instruments, 100, function (instrument, cb) {
    InstrumentDb.upsertWithWhere({
      instrument_token: instrument.instrument_token
    }, instrument, cb);
  }, function () {
    console.log(instruments.length);
    console.log('Updated');
  });
}

// saveInstruments();
new CronJob('0 0 21 * * 1-5', saveInstruments, null, true, 'Asia/Kolkata');