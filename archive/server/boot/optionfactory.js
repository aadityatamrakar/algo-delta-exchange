var request = require('request');

function getInstruments() {
  return new Promise(function (resolve, reject) {
    var options = {
      'method': 'GET',
      'url': 'https://api.sensibull.com/v1/instrument_details?_=' + (new Date()).getTime(),
      json: true,
      gzip: true,
      keepAlive: true,
    };
    request(options, function (error, response) {
      if (error) reject(error);
      try {
        resolve(response.body.data);
      } catch (err) {
        reject(error);
      }
    });
  })
}

function getLivePrices(token) {
  return new Promise(function (resolve, reject) {
    var options = {
      'method': 'GET',
      'url': 'https://api.sensibull.com/v1/live_derivative_prices/' + token,
      json: true,
      gzip: true,
      keepAlive: true,
    };
    request(options, function (error, response) {
      if (error) reject(error);
      try {
        resolve(response.body.data);
      } catch (err) {
        reject(error);
      }
    });
  })
}

function getStrategies(params) {
  return new Promise(function (resolve, reject) {
    var options = {
      'method': 'POST',
      'url': 'https://farstrategy.sensibull.com/api/v1/generateStrategies',
      body: Object.assign({
        "filterList": [{
          "filter": "DONT_SHOW_ITM"
        }],
        "sorterList": [
          "expectedProfit"
        ],
        "brokerCache": 2
      }, params),
      json: true,
      gzip: true,
      keepAlive: true,
    };
    request(options, function (error, response) {
      if (error) reject(error);
      try {
        resolve(response.body.result);
      } catch (err) {
        reject(error);
      }
    });
  })
}

let instrument_cache = {};

function getInstrumentDetails(symbol) {
  return new Promise(function (resolve, reject) {
    if (!instrument_cache[symbol]) {
      var options = {
        'method': 'GET',
        'url': 'https://api.sensibull.com/v1/instruments/' + symbol,
        json: true,
        gzip: true,
        keepAlive: true,
      };
      request(options, function (error, response) {
        if (error) reject(error);
        try {
          instrument_cache[symbol] = response.body.data;
          resolve(response.body.data);
        } catch (err) {
          reject(error);
        }
      });
    } else resolve(instrument_cache[symbol]);
  });
}

function builder(params) {
  return new Promise(function (resolve, reject) {
    var options = {
      'method': 'POST',
      'url': 'https://oxide.sensibull.com/v1/compute/2/builder?enable_per_lot=true&enable_payoff_chart=true&enable_trade_details=true',
      body: params,
      json: true,
      gzip: true,
      keepAlive: true,
    };

    request(options, function (error, response) {
      if (error) reject(error);
      try {
        resolve(response.body.payload);
      } catch (err) {
        reject(error);
      }
    });
  })
}

module.exports = function (app) {
  var router = app.loopback.Router();

  router.get('/instruments', (req, res) => {
    getInstruments()
      .then(data => {
        res.send({
          status: true,
          data: data
        });
      }).catch(error => {
        res.send({
          status: false,
          error: error
        });
      });
  });

  router.get('/instrument_strikes/:symbol', (req, res) => {
    if (req.params && req.params.symbol) {
      getInstrumentDetails(req.params.symbol)
        .then(data => {
          res.send({
            status: true,
            data: data
          });
        }).catch(error => {
          res.send({
            status: false,
            error: error
          });
        });
    } else {
      res.send({
        status: false,
        error: 'no symbol'
      });
    }
  });

  router.get('/live_prices/:token', (req, res) => {
    if (req.params && req.params.token) {
      getLivePrices(req.params.token)
        .then(data => {
          res.send({
            status: true,
            data: data
          });
        }).catch(error => {
          res.send({
            status: false,
            error: error
          });
        });
    } else {
      res.send({
        status: false,
        error: 'no token'
      });
    }
  });

  router.post('/builder', (req, res) => {
    if (req.body && req.body.trades && req.body.trades.length > 0) {
      builder(req.body)
        .then(data => {
          res.send({
            status: true,
            data: data
          });
        }).catch(error => {
          res.send({
            status: false,
            error: error
          });
        });
    } else {
      res.send({
        status: false,
        error: 'no trades'
      });
    }
  });

  router.post('/generator', (req, res) => {
    if (req.body && req.body.instrumentSymbol && req.body.marketView) {
      getStrategies(req.body)
        .then(data => {
          res.send({
            status: true,
            data: data
          });
        }).catch(error => {
          res.send({
            status: false,
            error: error
          });
        });
    } else {
      res.send({
        status: false,
        error: 'no trades'
      });
    }
  });

  app.use('/options', router);
}
