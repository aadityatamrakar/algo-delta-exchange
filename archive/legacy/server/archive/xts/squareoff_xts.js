const CronJob = require("cron").CronJob;
var async = require('async');
var fs = require('fs');
const notify = require("../lib/notify.js");
let pause = async function (ms) {
  return new Promise((r, c) => setTimeout(r, ms))
}
let channelId = 0;

let app = require('../server.js');
let accounts = [];

async function init() {
  try {
    let xtsAccount = app.models.xtsAccount;
    accounts = await xtsAccount.find({
      where: {
        name: {
          inq: ['A1789', 'A1965']
          // inq: ['A1528', 'A1789', 'A1965']
          // inq: ['SAIROM64']
        }
      }
    });
    console.log(accounts);
    async.eachLimit(accounts, 20, function (account, cb) {
      xtsAccount.loginClient(account).then(client => {
        if (client) {
          closePositions(client, cb);
        } else cb();
      });
    }, async function () {
      // notify('XTS: SquareOff Done', channelId);
      setTimeout(function () {
        process.exit();
      }, 30000);
    }, null, true, 'Asia/Kolkata');
  } catch (err) {
    notify('Start Error: ' + err.message, channelId);
  }
}

async function closePositions(client, cb) {
  try {
    let orders = await client.getOrderBook();
    orders = orders.result;
    let closedOrderStatus = ['Filled', 'Replaced', 'Cancelled', 'Rejected'];
    orders = orders.filter(row => (closedOrderStatus.indexOf(row.OrderStatus) == -1));
    console.log(client.clientCodes[0], 'orders', orders.length);
    for (let i = 0; i < orders.length; i++) {
      let cancelResp = await client.cancelOrder({
        appOrderID: orders[i].AppOrderID,
        orderUniqueIdentifier: orders[i].OrderUniqueIdentifier,
        ClientID: orders[i].ClientID
      });
      console.log(cancelResp);
    }

    let positions = await client.getPositions({
      dayOrNet: "NetWise"
    });
    console.log(positions);
    positions = positions.result.positionList.filter((pos) => (parseInt(pos.Quantity) != 0));
    console.log(client.clientCodes[0], 'positions', positions.length);
    for (let i = 0; i < positions.length; i++) {
      let transaction_type = parseInt(positions[i].Quantity) > 0 ? 'SELL' : 'BUY';

      if (Math.abs(parseInt(positions[i].Quantity)) > 2500) {
        let totalQuantity = Math.abs(parseInt(positions[i].Quantity));
        let runTimes = totalQuantity / 2500;

        for (let j = 0; j < runTimes; j++) {
          let resp = await client.placeOrder({
            exchangeSegment: client.exchangeInfo.NSEFO,
            exchangeInstrumentID: positions[i].ExchangeInstrumentId,
            productType: client.productTypes.NRML,
            orderType: client.orderTypes.Market,
            orderSide: client.orderSide[transaction_type],
            timeInForce: client.dayOrNet.DAY,
            disclosedQuantity: 0,
            limitPrice: 0,
            stopPrice: 0,
            orderQuantity: (totalQuantity > 2500 ? 2500 : totalQuantity),
            orderUniqueIdentifier: 'SQF'
          });
          // console.log(23, transaction_type, (totalQuantity > 2500 ? 2500 : totalQuantity));
          totalQuantity = totalQuantity - 2500;
          console.log(resp);
        }
      } else {
        let resp = await client.placeOrder({
          exchangeSegment: client.exchangeInfo.NSEFO,
          exchangeInstrumentID: positions[i].ExchangeInstrumentId,
          productType: client.productTypes.NRML,
          orderType: client.orderTypes.Market,
          orderSide: client.orderSide[transaction_type],
          timeInForce: client.dayOrNet.DAY,
          disclosedQuantity: 0,
          limitPrice: 0,
          stopPrice: 0,
          orderQuantity: Math.abs(parseInt(positions[i].Quantity)),
          orderUniqueIdentifier: 'SQF'
        });
        console.log(resp);
        // console.log(123, transaction_type, parseInt(positions[i].Quantity));
      }
    }

    cb();
  } catch (err) {
    console.log(err);
    cb();
  }
}

init();
new CronJob('0 10 15 * * 1-5', init, null, true, 'Asia/Kolkata');
