'use strict';
// const Zerodha = require('./../../server/lib/zerodha');
// let moment = require('moment');
// let RSI = require('./../../server/lib/indicators/rsi');
// let ATR = require('./../../server/lib/indicators/atr');
// let EMA = require('./../../server/lib/indicators/ema');
// let Stoch = require('./../../server/lib/indicators/stoch');
// let MACD = require('./../../server/lib/indicators/macd');
// let AO = require('./../../server/lib/indicators/ao');

module.exports = function (Instrument) {
  // let zapi = new Zerodha();
  // let accountId = '5f20a7559b6f40131e9da3d9';

  // Instrument.qoute = function (token, cb) {
  //   (async () => {
  //     let Account = Instrument.app.models.account;
  //     let account = await Account.findById(accountId);
  //     zapi.loadConfig(account);
  //     let session = await zapi.checkSession();
  //     if (!session) await zapi.login();
  //     getQoute(zapi, token, cb);
  //   })();
  // };

  // Instrument.remoteMethod("qoute", {
  //   http: {
  //     verb: "post"
  //   },
  //   accepts: [{
  //     arg: "token",
  //     type: "string"
  //   }],
  //   returns: {
  //     type: "object",
  //     root: true
  //   }
  // });

  // Instrument.fnoCandle = function (token, startDate, endDate, cb) {
  //   (async () => {
  //     let Account = Instrument.app.models.account;
  //     let account = await Account.findById(accountId);
  //     // Instrument.app.brokerConfig = account;
  //     zapi.loadConfig(account);
  //     let session = await zapi.checkSession();
  //     if (!session) await zapi.login();
  //     // app.emit('broker_connected', account);
  //     download(zapi, token, startDate, endDate, true, cb);
  //   })();
  // };

  // Instrument.remoteMethod("fnoCandle", {
  //   http: {
  //     verb: "post"
  //   },
  //   accepts: [{
  //     arg: "token",
  //     type: "string"
  //   }, {
  //     arg: "startDate",
  //     type: "number"
  //   }, {
  //     arg: "endDate",
  //     type: "number"
  //   }],
  //   returns: {
  //     type: "object",
  //     root: true
  //   }
  // });

  // Instrument.candles = function (token, startDate, endDate, cb) {
  //   (async () => {
  //     let Account = Instrument.app.models.account;
  //     let account = await Account.findById(accountId);
  //     zapi.loadConfig(account);
  //     let session = await zapi.checkSession();
  //     if (!session) await zapi.login();
  //     download(zapi, token, startDate, endDate, false, cb);
  //   })();
  // };

  // Instrument.remoteMethod("candles", {
  //   http: {
  //     verb: "post"
  //   },
  //   accepts: [{
  //     arg: "token",
  //     type: "string"
  //   }, {
  //     arg: "startDate",
  //     type: "number"
  //   }, {
  //     arg: "endDate",
  //     type: "number"
  //   }],
  //   returns: {
  //     type: "object",
  //     root: true
  //   }
  // });

  // function download(zapi, token, startDate, endDate, isFNO, resolve) {
  //   let pre_startDate = moment(startDate, 'X').subtract(30, 'day').format('YYYY-MM-DD');
  //   let endDateF = moment(endDate, 'X').format('YYYY-MM-DD');
  //   zapi.historyData(token, 'minute', pre_startDate, endDateF)
  //     .then(async resp => {
  //       resp = await RSI(resp, 8);
  //       resp = await ATR(resp, 7, 2);
  //       resp = await Stoch(resp, 10);
  //       resp = await EMA(resp, 3, 'close', 'ema3');
  //       resp = await EMA(resp, 5, 'close', 'ema5');
  //       resp = await EMA(resp, 9, 'close', 'ema9');
  //       resp = await EMA(resp, 15, 'close', 'ema15');
  //       resp = await MACD(resp, 21);
  //       resp = await AO(resp);
  //       // resp = await COG(candleData, 0.0004, 15, 14, 3);
  //       resp = resp.map(c => {
  //         c.time = parseInt(moment(c.ts).startOf('minute').add('330', 'minute').format('X'));
  //         return c;
  //       }).filter(c => {
  //         return c.time > startDate && c.time < endDate
  //       });

  //       resolve(null, {
  //         status: true,
  //         data: resp
  //       });
  //     })
  //     .catch((err) => {
  //       resolve(null, {
  //         status: false,
  //         token: token,
  //         error: err
  //       });
  //     });
  // }

  // function getQoute(zapi, token, resolve) {
  //   zapi.getQoute(token)
  //     .then(async resp => {
  //       resolve(null, {
  //         status: true,
  //         data: resp
  //       });
  //     })
  //     .catch((err) => {
  //       resolve(null, {
  //         status: false,
  //         token: token,
  //         error: err
  //       });
  //     });
  // }

};
