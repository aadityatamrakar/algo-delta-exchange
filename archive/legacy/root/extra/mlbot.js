let data = require('./bn2.json');
// let data2 = require('./bn.json');
const Supertrend = require('./server/lib/indicators/atr.js');
const Stoch = require('./server/lib/indicators/stoch')
const ML = require('./estimator')
let fs = require('fs');
let moment = require('moment');

async function init() {
  data = await Stoch(data, 8, 'rf');
  data = await Stoch(data, 14, 'rs');

  // data2 = await RSI(data2, 7, 'close', 'rf');
  // data2 = await RSI(data2, 14, 'close', 'rs');

  let trainingData = fs.createWriteStream('training.txt', 'utf8');

  let X = [],
    y = [];
  let tmpX = [],
    tmpY = [];
  let oldDay = 'a',
    newDay = 'b',
    daysLoaded = 0;

  let cummReturn = 0;
  let trend = 'NA',
    entry = 0;

  let learningDays = 2;
  let winDays = 0;
  let lossDays = 0;
  let totalWin = 0;
  let totalLoss = 0;
  let maxLoss = 0;
  let maxProfit = 0;
  let knn = [];
  let knnLength = 7;
  let takeTrades = true;

  for (i = 375, l = data.length; i < l; i++) {
    newDay = data[i].ts.substr(0, 10);

    if (oldDay != newDay) {
      oldDay = newDay;

      X.push(...tmpX);
      tmpX = [];

      y.push(...tmpY);
      tmpY = [];

      if (X.length > (learningDays * 375)) X = X.slice(-(learningDays * 375));
      if (y.length > (learningDays * 375)) y = y.slice(-(learningDays * 375));
      daysLoaded += 1;
      takeTrades = true;
    }


    if ((data[i].close - data[i - 1].close) > 0) trainingData.write(`${data[i - 1].rf},${data[i - 1].rs},${1}\n`), tmpY.push(1);
    else if ((data[i].close - data[i - 1].close) < 0) trainingData.write(`${data[i - 1].rf},${data[i - 1].rs},${2}\n`), tmpY.push(2);
    else trainingData.write(`${data[i - 1].rf},${data[i - 1].rs},${3}\n`), tmpY.push(3);
    tmpX.push([data[i - 1].rf, data[i - 1].rs]);


    // if ((data[i].close - data[i - 1].close) > 0) y.push(1);
    // else if ((data[i].close - data[i - 1].close) < 0) y.push(2);
    // else y.push(3);
    // X.push([data[i - 1].rf, data[i - 1].rs]);

    if (daysLoaded > learningDays) {
      let direction2 = ML([data[i].rf, data[i].rs], X, y);

      if (direction2 == 1) direction2 = 1;
      if (direction2 == 2) direction2 = -1;
      if (direction2 == 3) direction2 = 0;

      knn.push(direction2);
      if (knn.length > knnLength) knn.shift();

      let newTrend = knn.reduce((s, a) => (s += a, s), 0);
      newTrend = newTrend == 0 ? 0 : newTrend > 0 ? -1 : 1;

      if (trend != newTrend) {
        if (newTrend == 1) {
          // trainingData.write(`${data[i].ts},BUY,${Math.round(data[i].close)}\n`);
          // console.log(data[i].ts, 'BUY', data[i].close);
          if (entry != 0) entry += data[i].close;
          // console.log('Running PNL', Math.round(entry * -1));
          entry += data[i].close;
          trend = newTrend;
        } else if (newTrend == -1) {
          // trainingData.write(`${data[i].ts},SELL,${Math.round(data[i].close)}\n`);
          // console.log(data[i].ts, 'SELL', data[i].close);
          if (entry != 0) entry -= data[i].close;
          // console.log('Running PNL', Math.round(entry * -1));
          entry -= data[i].close;
          trend = newTrend;
        }
      }

      if (data[i].ts.indexOf('T15:25:00') != -1) {
        if (trend == -1) entry += data[i].close;
        else if (trend == 1) entry -= data[i].close;
        entry *= -1;
        cummReturn += entry;
        // trainingData.write(`${data[i].ts.substr(0, 10)},${Math.round(cummReturn)},${Math.round(entry)}\n`);
        console.log(data[i].ts.substr(0, 10), Math.round(cummReturn), Math.round(entry));

        if (entry > 0) winDays += 1, totalWin += entry, maxProfit = maxProfit < entry ? entry : maxProfit;
        if (entry < 0) lossDays += 1, totalLoss += entry, maxLoss = maxLoss > entry ? entry : maxLoss;
        entry = 0;
        trend = 0;
      }

      // trainingData.write(`${data[i].ts},${direction2},${data[i].close}\n`);
    }
  }

  console.log(winDays, lossDays, totalWin, totalLoss, Math.round(maxProfit), Math.round(maxLoss), Math.round((totalLoss / lossDays)), Math.round((totalWin / winDays)));

  trainingData.close();
  // console.log(data.slice(-5));
}

init();

// let LL = require("./server/lib/indicators/low");
// let HH = require("./server/lib/indicators/high");
// let SMA = require("./server/lib/indicators/sma");
// let LinReg = require("./server/lib/indicators/linreg");

// async function check() {
//   let period = 14;
//   data = await LL(data, 'low', 'LL', period);
//   data = await HH(data, 'high', 'HH', period);
//   data = await SMA(data, period, 'close', 'sma');
//   data.forEach(tick => {
//     tick.vol = (tick.close - ((((tick.HH + tick.LL) / 2) + tick.sma) / 2));
//   });
//   data = await LinReg(data.slice(-(75 + period)), 'vol', 'linreg', 20);
//   console.log(data.slice(-15).map(c => [c.ts, c.close, parseNumber(c.vol), parseNumber(c.linreg)]));
// }

// function parseNumber(n) {
//   return Math.round(n * 100) / 100;
// }

// check();
