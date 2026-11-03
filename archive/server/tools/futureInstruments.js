var request = require('request');

async function getInstrumentDetails() {
  return new Promise((resolve, reject) => {
    var options = {
      'method': 'GET',
      'url': 'https://api.sensibull.com/v1/instrument_details',
      headers: {
        "cookie": "access_token=free_user;",
      },
      json: true,
    };
    request(options, function (error, response) {
      try {
        resolve(response.body.data);
      } catch (err) {
        console.log(err);
        resolve([]);
      }
    });
  })
}

async function download(filterStocks = false) {
  return new Promise(async function (resolve, reject) {
    try {
      let optionData = await getInstrumentDetails();
      let tradeableSymbols = {};
      if (!filterStocks) filterStocks = Object.keys(optionData);
      optionData = Object.values(optionData);
      for (let index = 0; index < optionData.length; index++) {
        if (Object.values(optionData[index].per_expiry_data).length > 1) {
          optionData[index].future = Object.values(optionData[index].per_expiry_data)
            .filter(c => {
              return c.future_instrument_token != 0
            })
            .sort((a, b) => {
              return a.daysToExpiry - b.daysToExpiry
            })[0];
        }

        if (optionData[index].future && filterStocks.indexOf(optionData[index].future.underlying) != -1) {
          tradeableSymbols[optionData[index].future.underlying] = {
            tradingsymbol: optionData[index].future.future_symbol,
            instrument_token: optionData[index].future.future_instrument_token,
            lot_size: optionData[index].future.lot_size,
            expiry: optionData[index].future.expiry,
            max_pain: parseInt(optionData[index].future.max_pain),
          }
        }
      }
      resolve(tradeableSymbols);
    } catch (err) {
      console.log(err);
      resolve([]);
    }
  })
}

module.exports = download;