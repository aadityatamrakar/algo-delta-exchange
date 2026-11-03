var XTSInteractive = require('xts-interactive-api').Interactive;
var XTSInteractiveWS = require('xts-interactive-api').WS;
let fs = require('fs');
let moment = require('moment');

<<<<<<< Updated upstream
// let xtsClient = new XTSInteractive("http://greekctcl-09.trustline.in:3000");
// let xtsClient = new XTSInteractive("https://ttblaze.iifl.com/");
// let xtsClient = new XTSInteractive("http://14.142.188.188:23000");
// let xtsClient = new XTSInteractive("https://mtrade.arhamshare.com");
// let xtsClient = new XTSInteractive("http://14.97.72.8:3000");
let xtsClient = new XTSInteractive("http://122.176.89.77:3000/interactive");
// let xtsClient = new XTSInteractive("https://itrader.purebroking.com");
// let credentials = {
//   "appKey": "2c606e8933f1d0de4e4774",
//   "secretKey": "Adim176#US"
// };
// let credentials = {
//   "appKey": "7bf824e587e940854f9211",
//   "secretKey": "Rhko213@OV"
// };
// let credentials = {
//   "appKey": "48ffb373674ebc569cd488",
//   "secretKey": "Cymt660@Fm"
// };
let credentials = {
  "appKey": "487bb8ac390d87b7d27773",
  "secretKey": "Kdiw534$rA"
};

// let token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySUQiOiJaWko0MzUxXzJDNjA2RTg5MzNGMUQwREU0RTQ3NzQiLCJwdWJsaWNLZXkiOiIyYzYwNmU4OTMzZjFkMGRlNGU0Nzc0IiwiaWF0IjoxNjczNjgwODg0LCJleHAiOjE2NzM3NjcyODR9.ujIuULY-bxPFs9T6Vn5Q525N7RfimVJ4OzYxKgA-Ga4';
// let userId = "ZZJ4351";
// let clientId = "M6000";

=======
let xtsClient = new XTSInteractive("http://ctrade.jainam.in:3000/interactive");
let credentials = {
  "appKey": "322b2708115c54c7dac680",
  "secretKey": "Hykb386#vL"
};

>>>>>>> Stashed changes
async function init() {
  // let lookup = await xtsClient.hostLookup();
  // console.log(lookup);
  // xtsClient = new XTSInteractive();
  // credentials.uniqueKey = lookup.uniqueKey;
  let logIn = await xtsClient.logIn(credentials);
<<<<<<< Updated upstream
  // logIn = await xtsClient.loginWithToken(xtsClient._userID, xtsClient._token);

  // let logIn = await xtsClient.loginWithToken(userId, token);
  console.log(logIn, xtsClient);
  
  // let orders = await xtsClient.getDealerOrders({
  //   clientID: clientId
  // });
  // console.log(orders);

  // let appOrderID = "1200028704";
  // let resp = await xtsClient.getOrderHistory(appOrderID);
  // if (resp.code == "s-orders-0001" && resp.result.length > 0) {
  //   let orderDetails = resp.result[resp.result.length - 1];
  //   console.log(JSON.stringify(orderDetails, null, 2));
  // }

  // console.log('UserID: ', xtsClient._userID);

  // startSocket({
  //   userId,
  //   clientId,
  //   token
  // });

  // setTimeout(function () {
  // placeOrder(xtsClient, 49046, 25, 'BUY');
  // }, 5000);

  // console.log(JSON.stringify(logIn, null, 2));
  // console.log(logIn.result.userID);
  // fs.writeFileSync('xts2.json', JSON.stringify(logIn, null, 2));

  // let profile = await xtsClient.getProfile({clientID: "M6000"});
  // console.log(profile);

  // setInterval(_ => {
  //   console.log(logIn.result.token);
  //   xtsClient.loginWithToken(logIn.result.clientCodes[0], logIn.result.token).then(c => console.log(c));
  // }, 3000);

  // let balance = await xtsClient.getBalance({ clientID: "DBD0C" });
  // console.log(balance.result);
  // balance = await xtsClient.getBalance({});
  // console.log(balance.result);
  // balance = await xtsClient.getBalance({ clientID: "M6000" });
  // console.log(balance.result);
  // console.log('Margin: ', balance.result.BalanceList[0].limitObject);

  // console.time('get_orderbook');
  // let orders = await xtsClient.getOrderBook({ clientID: clientId });
  // orders = orders.result;
  // console.timeEnd('get_orderbook');
  // console.log(orders);
  // fs.writeFileSync('xts_orders.json', JSON.stringify(orders, null, 2));

  // let positions = await xtsClient.getDealerPositions({
  //   clientID: "1AB95",
  //   dayOrNet: "NetWise"
  // });
  // console.log(positions);
  // fs.writeFileSync('xts_dealer_positions.json', JSON.stringify(positions, null, 2));
  // positions = await xtsClient.getPositions({
  //   clientID: "B800",
  //   dayOrNet: "NetWise"
  // });
  // fs.writeFileSync('xts_positions.json', JSON.stringify(positions, null, 2));
  // console.log(positions);
  // let totalAccountPnl = positions.result.positionList.reduce((s, c) => {
  //   s+=parseFloat(c.MTM.replace(/,/g, ''))
  //   return s;
  // }, 0);
  // console.log(totalAccountPnl);
  // positions = positions.result.positionList;

  // console.log(xtsClient.clientCodes[0]);
  // positions = positions.result.positionList;

  // fs.writeFileSync('xts.json', JSON.stringify({
  //   orders,
  //   positions
  // }));


  // for (let i = 0; i < 100; i++) {
  //   placeOrder(xtsClient, 47209, 25, 'BUY');
  // }


  // placeOrder(xtsClient, 42379, 25, 'BUY');
  // setTimeout(_ => {
  //   placeOrder(xtsClient, 42379, 25, 'SELL');
  //   setTimeout(_ => {
  //     placeOrder(xtsClient, 42379, 25, 'BUY');
  //     setTimeout(_ => {
  //     }, 3000);
  //   }, 3000);
  // }, 3000);
}

async function placeOrder(client, instrumentId, lotSize, orderType, price) {
  let ts = Math.round(Math.random() * 10000);
  console.time('order' + ts);
  let response = await client.placeOrder({
    clientID: client._userID,
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
    orderUniqueIdentifier: 'Test'
  });
  console.log(response);
  console.timeEnd('order' + ts);
}

function startSocket(account) {
  let xtsInteractiveWS = new XTSInteractiveWS("http://ctrade.jainam.in:3000");
  xtsInteractiveWS.init({
    userID: account.userId,
    clientID: account.clientId,
    token: account.token
  });

  xtsInteractiveWS.onConnect((...args) => console.log('onConnect', args));
  xtsInteractiveWS.onJoined((...args) => console.log('onJoined', args));
  xtsInteractiveWS.onError((...args) => console.log('onError', args));
  xtsInteractiveWS.onDisconnect((...args) => console.log('onDisconnect', args));
  xtsInteractiveWS.onOrder((...args) => console.log('onOrder', args));
  xtsInteractiveWS.onTrade((...args) => console.log('onTrade', args));
  xtsInteractiveWS.onPosition((...args) => console.log('onPosition', args));
=======
  console.log(logIn, xtsClient);
>>>>>>> Stashed changes
}

init();
