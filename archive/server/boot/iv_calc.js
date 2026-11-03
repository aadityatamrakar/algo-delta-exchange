'use strict';

const moment = require('moment');
const fs = require('fs');
const debounce = require('./../lib/debounce');
const async = require('async');
const Zerodha = require('./../lib/zerodha');
const kiteTicker = require('./../lib/KiteTicker');
const optionConfig = require('./../tools/optionInstruments');
const futuresConfig = require('../tools/futureInstruments');
const notify = require('./../lib/notify');
const CronJob = require("cron").CronJob;
let {
  b76_ivol
} = require('./../lib/option-pricing');

module.exports = function (app) {
  let indexToken, futureToken, futureSymbol, currentExpiryOptions, callOptions = false, putOptions = false;
  let saveData = false,
    futurePrice = 0,
    indexPrice = 0,
    ticksCache = {},
    call_summary, put_summary,
    tickHistory = {},
    tte = moment().day(4).hour(15).minute(30).utcOffset('+05:30');

  if ((tte.diff(moment(), 'minutes') / 1440) < 0) {
    tte = moment().add(1, 'week').day(4).hour(15).minute(30).utcOffset('+05:30');
  }

  function start(socket) {
    console.log('iv_calc');
    setTimeout(function () {
      socket.emit('history', Object.values(tickHistory));
    }, 2000);
    // setInterval(dummy, 1000);
  }

  let m = (new Date()).getTime();
  // let txtFile = fs.createWriteStream(m + '.txt', 'utf8');
  let liveFeed;
  async function ticker(subs) {
    liveFeed = new kiteTicker({
      api_key: 'kitefront',
      access_token: app.token
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

  async function subscribe(subs) {
    liveFeed.subscribe(subs);
    liveFeed.setMode(liveFeed.modeFull, subs);
  }

  async function init() {
    let optionData = await optionConfig.download();
    futureToken = optionData.currentFuture.token;
    futureSymbol = optionData.currentFuture.symbol;
    indexToken = 260105;
    currentExpiryOptions = optionData.weeklyInstruments;
    ticker([futureToken, indexToken]);
  }

  async function checkTicks(ticks) {
    ticks = ticks.reduce(function (ob, el) {
      ob[el.instrument_token] = el;
      return ob;
    }, {});
    
    Object.assign(ticksCache, ticks);
    
    if (callOptions === false && putOptions === false) {
      if (ticksCache[indexToken]) {
        let atm = Math.round(ticksCache[indexToken].last_price / 100) * 100;
        let upper = atm + 1101;
        let lower = atm - 1101;
        callOptions = Object.values(currentExpiryOptions).filter(c => c.instrument_type == 'CE' && c.strike > lower && c.strike < upper);
        putOptions = Object.values(currentExpiryOptions).filter(c => c.instrument_type == 'PE' && c.strike > lower && c.strike < upper);
        let optionTokens = callOptions.map(c => c.instrument_token).concat(putOptions.map(c => c.instrument_token));
        subscribe(optionTokens);
      }
      return;
    }
    
    call_summary = callOptions.reduce((s, opt) => {
      if (ticksCache[opt.instrument_token]) {
        s.below_atp += ticksCache[opt.instrument_token].last_price < ticksCache[opt.instrument_token].average_price ? 1 : 0;
        s.total += 1;
        s.vol += ticksCache[opt.instrument_token].volume;
        s.oi += ticksCache[opt.instrument_token].oi;
        s.oi_high += ticksCache[opt.instrument_token].oi_day_high;
        s.oi_low += ticksCache[opt.instrument_token].oi_day_low;
        s.buy_quantity += ticksCache[opt.instrument_token].buy_quantity;
        s.sell_quantity += ticksCache[opt.instrument_token].sell_quantity;
      }
      return s;
    }, {
      total: 0,
      below_atp: 0,
      oi: 25,
      vol: 0,
      oi_high: 0,
      oi_low: 0,
      buy_quantity: 0,
      sell_quantity: 0,
    });

    put_summary = putOptions.reduce((s, opt) => {
      if (ticksCache[opt.instrument_token]) {
        s.below_atp += ticksCache[opt.instrument_token].last_price < ticksCache[opt.instrument_token].average_price ? 1 : 0;
        s.total += 1;
        s.vol += ticksCache[opt.instrument_token].volume;
        s.oi += ticksCache[opt.instrument_token].oi;
        s.oi_high += ticksCache[opt.instrument_token].oi_day_high;
        s.oi_low += ticksCache[opt.instrument_token].oi_day_low;
        s.buy_quantity += ticksCache[opt.instrument_token].buy_quantity;
        s.sell_quantity += ticksCache[opt.instrument_token].sell_quantity;
      }
      return s;
    }, {
      total: 0,
      below_atp: 0,
      oi: 25,
      vol: 0,
      oi_high: 0,
      oi_low: 0,
      buy_quantity: 0,
      sell_quantity: 0,
    });

    indexPrice = _TP(indexToken);
    futurePrice = _TP(futureToken);
    let ATM_strike = Math.round(indexPrice / 100) * 100;

    let iv_tick = {
      'index': indexPrice,
      'future': futurePrice,
      'atm_strike': ATM_strike,
      'atm_ce_price': _SP(ATM_strike + 'CE'),
      'atm_pe_price': _SP(ATM_strike + 'PE'),
      'atm_ce_vol': getVol(ATM_strike, 'C'),
      'atm_pe_vol': getVol(ATM_strike, 'P'),
      'pcr': (Math.round((put_summary.oi / call_summary.oi) * 100) / 100),
      'ce_buy_quantity': call_summary.buy_quantity,
      'ce_sell_quantity': call_summary.sell_quantity,
      'pe_buy_quantity': put_summary.buy_quantity,
      'pe_sell_quantity': put_summary.sell_quantity,
      'ce_signal': roundOff(call_summary.below_atp / call_summary.total),
      'pe_signal': roundOff(put_summary.below_atp / put_summary.total),
      'ce_oi': call_summary.oi,
      'pe_oi': put_summary.oi,
      'ce_oi_high': call_summary.oi_high,
      'pe_oi_high': put_summary.oi_high,
      'ce_oi_low': call_summary.oi_low,
      'pe_oi_low': put_summary.oi_low,
      'ce_vol': call_summary.vol,
      'pe_vol': put_summary.vol
    };

    if (saveData) {
      app.io.emit("tick", iv_tick);
      let ts = moment().millisecond(0).utcOffset('+0530').format('X');
      tickHistory[ts] = {
        time: parseInt(ts),
        index: roundOff(indexPrice),
        ce_vol: roundOff(iv_tick.atm_ce_vol),
        pe_vol: roundOff(iv_tick.atm_pe_vol),
        ce_signal: roundOff(call_summary.below_atp / call_summary.total),
        pe_signal: roundOff(put_summary.below_atp / put_summary.total),
      };
    }
  }

  function getVol(strike, type) {
    let dte = (tte.diff(moment(), 'minutes') / 1440);
    let underlying_price = _TP(indexToken);

    let time_to_expiry = dte / 365;
    let risk_free_interest = 7;
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
    app.io.emit('tick', sample);
  }

  function checkToken(cb) {
    console.log('checking token', app.token);
    if (app.token) {
      setTimeout(cb, 2000);
    } else {
      console.log('retry');
      setTimeout(function () {
        checkToken(cb);
      }, 2000);
    }
  }

  function saveDatafile() {
    fs.writeFileSync(moment().format('YYYYMMDD') + ".json", JSON.stringify(tickHistory));
  }
  let saveDataInterval;
  app.on('started', function () {
    // if (require.main.filename.replace(require.main.path + '/', '') === 'server.js') {
    //   checkToken(init);
    //   if (fs.existsSync(moment().format('YYYYMMDD') + ".json")) {
    //     tickHistory = JSON.parse(fs.readFileSync(moment().format('YYYYMMDD') + ".json"));
    //   }
    //   new CronJob('0 15 9 * * 1-5', function () {
    //     saveData = true;
    //     saveDataInterval = setInterval(saveDatafile, 1000 * 60);
    //   }, null, true, 'Asia/Kolkata');
    //   new CronJob('0 30 15 * * 1-5', function () {
    //     saveData = false;
    //     saveDatafile();
    //     clearInterval(saveDataInterval);
    //   }, null, true, 'Asia/Kolkata');
    //   app.io.on('connection', start);
    // }
  });
};
