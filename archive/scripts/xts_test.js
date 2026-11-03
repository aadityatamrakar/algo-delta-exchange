var XTSInteractive = require('xts-interactive-api').Interactive;
var XTSInteractiveWS = require('xts-interactive-api').WS;
let fs = require('fs');
let async = require('async');
let moment = require('moment');

let server_url = "http://14.97.57.98:3001";
// let server_url = "http://ctrade.jainam.in:3000";
let xtsClient = new XTSInteractive(server_url);

// let token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySUQiOiJEQkQwQ180NjRCQUZBQjYxRTA1RjE0NDk4NTY0IiwicHVibGljS2V5IjoiNDY0YmFmYWI2MWUwNWYxNDQ5ODU2NCIsImlhdCI6MTY1Mzg4MjAwMCwiZXhwIjoxNjUzOTY4NDAwfQ.PjCwbPXN50TJi1fbseCSD4nDcJ-Vk9vzJlfDHYeWrG8';
// let userId = 'DBD0C';
// let clientId = 'J24';

let token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySUQiOiJCODAwXzRCNjAwMDQ0ODgwNzAzOTYyNDYzNTAiLCJwdWJsaWNLZXkiOiI0YjYwMDA0NDg4MDcwMzk2MjQ2MzUwIiwiaWF0IjoxNjU0MTQxMjAwLCJleHAiOjE2NTQyMjc2MDB9.pX5kp8IzvcmiGzU5bu5J5tJEUOV_jdLDXhViBA1UeCQ';
let userId = 'B800';
let clientId = 'B800';

async function init() {
  // logIn = await xtsClient.loginWithToken(userId, token);
  // console.log(logIn, xtsClient);

  xtsClient.userID = userId;
  xtsClient.token = token;
  xtsClient.enums = {};
  xtsClient.clientCodes = [clientId];
  xtsClient._token = token;
  xtsClient._userID = userId;
  // xtsClient.isInvestorClient = true;
  xtsClient.isInvestorClient = clientId == userId ? true : false;
  xtsClient.isLoggedIn = true;

  // console.time('check1');
  // try {
  //   let positions = await xtsClient.getDealerPositions({
  //     dayOrNet: "NetWise",
  //     // clientID: userId,
  //     clientID: xtsClient.clientCodes[0]
  //   });
  //   // let positions = await xtsClient.getPositions({
  //   //   clientID: xtsClient.clientCodes[0],
  //   //   dayOrNet: "NetWise"
  //   // });
  //   // if (positions.error && positions.error.message.indexOf('e-session') != -1) {
  //   //   console.log('logged out');
  //   // } else 
  //   fs.writeFileSync('positions.json', JSON.stringify(positions, null, 2));
  //   console.log(positions);
  // } catch (err) {
  //   console.log(err.message);
  // }
  // console.timeEnd('check1');
  
  // BANKNIFTY2260232500PE: 35465, 300
  // BANKNIFTY2260235400PE: 48830, -4800
  // BANKNIFTY2260235600PE: 48839, -4800
  // BANKNIFTY2260235700PE: 48847, -1200
  // BANKNIFTY2260235600CE: 48834, -1200
  // BANKNIFTY2260235700CE: 48840, -1200
  // BANKNIFTY2260235800CE: 48848, -1200
  // BANKNIFTY2260238500CE: 49005, 300
  
  // await placeOrder("CE", xtsClient, 48830, 1200, "BUY");
  // await placeOrder("CE", xtsClient, 48830, 1200, "BUY");
  // await placeOrder("CE", xtsClient, 48830, 1200, "BUY");
  // await placeOrder("CE", xtsClient, 48830, 1200, "BUY");

  // await placeOrder("CE", xtsClient, 48839, 1200, "BUY");
  // await placeOrder("CE", xtsClient, 48839, 1200, "BUY");
  // await placeOrder("CE", xtsClient, 48839, 1200, "BUY");
  // await placeOrder("CE", xtsClient, 48839, 1200, "BUY");

  // await placeOrder("CE", xtsClient, 48847, 1200, "BUY");
  // await placeOrder("CE", xtsClient, 48834, 1200, "BUY");
  // await placeOrder("CE", xtsClient, 48840, 1200, "BUY");
  // await placeOrder("CE", xtsClient, 48848, 1200, "BUY");
  // await placeOrder("CE", xtsClient, 35465, 300, "SELL");
  // await placeOrder("CE", xtsClient, 49005, 300, "SELL");
  
  
  await placeOrder("CE", xtsClient, 48831, 1200, "SELL");
  await placeOrder("CE", xtsClient, 48828, 1200, "SELL");
  await placeOrder("CE", xtsClient, 48831, 1200, "SELL");
  await placeOrder("CE", xtsClient, 48828, 1200, "SELL");

  
  // startSocket({
  //   userId,
  //   clientId,
  //   token
  // });

  // 18750 qty
  // await placeOrder("CE", xtsClient, 49046, 1200, 'BUY');
  // await placeOrder("PE", xtsClient, 48749, 1200, 'BUY');
  // await placeOrder("CE", xtsClient, 49046, 1200, 'BUY');
  // await placeOrder("PE", xtsClient, 48749, 1200, 'BUY');
  // await placeOrder("CE", xtsClient, 49046, 1200, 'BUY');
  // await placeOrder("PE", xtsClient, 48749, 1200, 'BUY');
  // await placeOrder("CE", xtsClient, 49046, 1200, 'BUY');
  // await placeOrder("PE", xtsClient, 48749, 1200, 'BUY');
  // await placeOrder("CE", xtsClient, 49046, 1200, 'BUY');
  // await placeOrder("PE", xtsClient, 48749, 1200, 'BUY');
  // await placeOrder("CE", xtsClient, 49046, 1200, 'BUY');
  // await placeOrder("PE", xtsClient, 48749, 1200, 'BUY');
  // await placeOrder("CE", xtsClient, 49046, 1200, 'BUY');
  // await placeOrder("PE", xtsClient, 48749, 1200, 'BUY');
  // await placeOrder("CE", xtsClient, 49046, 1200, 'BUY');
  // await placeOrder("PE", xtsClient, 48749, 1200, 'BUY');
  // await placeOrder("CE", xtsClient, 49046, 1200, 'BUY');
  // await placeOrder("PE", xtsClient, 48749, 1200, 'BUY');
  // await placeOrder("CE", xtsClient, 49046, 1200, 'BUY');
  // await placeOrder("PE", xtsClient, 48749, 1200, 'BUY');
  // await placeOrder("CE", xtsClient, 49046, 1200, 'BUY');
  // await placeOrder("PE", xtsClient, 48749, 1200, 'BUY');
  // await placeOrder("CE", xtsClient, 49046, 1200, 'BUY');
  // await placeOrder("PE", xtsClient, 48749, 1200, 'BUY');
  // await placeOrder("CE", xtsClient, 49046, 1200, 'BUY');
  // await placeOrder("PE", xtsClient, 48749, 1200, 'BUY');
  // await placeOrder("CE", xtsClient, 49046, 1200, 'BUY');
  // await placeOrder("PE", xtsClient, 48749, 1200, 'BUY');
  // await placeOrder("CE", xtsClient, 49046, 1200, 'BUY');
  // await placeOrder("PE", xtsClient, 48749, 1200, 'BUY');
  // await placeOrder("CE", xtsClient, 49046, 750, 'BUY');
  // await placeOrder("PE", xtsClient, 48749, 750, 'BUY');

  // let trade = true;
  // console.log('starting');
  // while (trade) {
  //   if (moment().format('ss') == '00') {
  //     trade = false;
  //     async.times(10, function (n, cb) {
  //       (async () => {
  //         await placeOrder(n + "_Buy", xtsClient, 57285, 1200, 'BUY');
  //         await placeOrder(n + "_Sell", xtsClient, 57285, 1200, 'SELL');
  //         cb();
  //       })();
  //     }, function () {
  //       console.log('Done');
  //     });
  //   }
  // }


  // setTimeout(function () {
  //   placeOrder(xtsClient, 67886, 25, 'BUY');
  //   setTimeout(function () {
  //     placeOrder(xtsClient, 67886, 25, 'SELL');
  //   }, 5000);
  // }, 5000);
}

async function placeOrder(id, client, instrumentId, lotSize, orderType, price) {
  let orderId = 'order_' + id;
  console.log('order sending: ' + orderId, moment().utc().add(330, 'minutes').format('HH:mm:ss.SSSSSSSSS'));
  console.time(orderId);
  let response = await client.placeOrder({
    clientID: clientId,
    exchangeSegment: "NSEFO",
    exchangeInstrumentID: instrumentId,
    productType: "NRML",
    orderType: "Market",
    orderSide: orderType,
    timeInForce: "DAY",
    disclosedQuantity: 0,
    limitPrice: 0,
    stopPrice: 0,
    orderQuantity: lotSize,
    orderUniqueIdentifier: 'B4'
  });
  console.log(response);
  console.timeEnd(orderId);
  console.log('order response received: ' + orderId, moment().utc().add(330, 'minutes').format('HH:mm:ss.SSSSSSSSS'));
  return true;
}

function startSocket(account) {
  let xtsInteractiveWS = new XTSInteractiveWS(server_url);
  xtsInteractiveWS.init({
    userID: account.userId,
    token: account.token
  });

  xtsInteractiveWS.onConnect((...args) => console.log('onConnect', args));
  xtsInteractiveWS.onJoined((...args) => console.log('onJoined', args));
  xtsInteractiveWS.onError((...args) => console.log('onError', args));
  xtsInteractiveWS.onDisconnect((...args) => console.log('onDisconnect', args));
  xtsInteractiveWS.onOrder((...args) => console.log('onOrder', args));
  xtsInteractiveWS.onTrade((...args) => console.log('onTrade', args));
  xtsInteractiveWS.onPosition((...args) => console.log('onPosition', args));
}

init();
