var request = require('request');
// var report = require('./../feeders/stocksReport');
var fs = require('fs');

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

module.exports = function (app) {
  var router = app.loopback.Router();

  router.get('/fno/meta/:id', (req, res) => {
    getInstrumentMeta([req.params.id]).then(resp => {
      let data = resp.derivatives[req.params.id];
      res.send(data);
    });
  });

  router.get('/fno/instruments', (req, res) => {
    instruments().then(_ => res.send(_));
  });

  router.get('/fno/details/:id', (req, res) => {
    getInstrumentDetails(req.params.id).then(_ => res.send(_))
  });

  router.get('/fno/chain/:id', (req, res) => {
    getOptionChain(req.params.id).then(resp => {
      res.send(resp.data);
    });
  });

  router.get('/fno/analysis/:id', (req, res) => {
    if (req.query && req.query.expiry) {
      analyseNifty(req.params.id, req.query.expiry)
        .then(resp => {
          res.send(resp);
        });
    } else res.send({
      status: false,
      error: "no expiry date"
    })
  });
  
  app.use(router);
}
