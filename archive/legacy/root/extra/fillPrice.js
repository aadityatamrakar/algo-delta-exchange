let orders = require('../missing.json');
var request = require('request');
var moment = require('moment');

let zerodha_token = 'yomlUt1WwxRm6NylfnVuTrp9AiRq1L+xMKic64mhOYwSOiEJ/e3usFocNl41zegnFQ63y8gnfnSzLMJsfIXEdjH+t1f/0SPT51G8r/clZvCmyEj2IQXl9w==';
let lb_token = 'lof0LvVdxRwvBMxtFtpsPDa2H2yEPDAEB1fBIbACJ0nmkG34msXHcRjmCR9HCKJe';

function getPrice(order) {
  return new Promise((resolve, reject) => {
    let candleTime = moment(order.order_timestamp).add(630, 'minutes').format('YYYY-MM-DD HH:mm:00');
    let candleTime2 = moment(order.order_timestamp).add(630, 'minutes').format('YYYY-MM-DD HH:mm:00');
    
    // let candleTime = moment(order.order_timestamp).format('YYYY-MM-DD HH:mm:00');
    // let candleTime2 = moment(order.order_timestamp).format('YYYY-MM-DD HH:mm:00');
    // console.log(candleTime, candleTime2);
    
    var options = {
      'method': 'GET',
      'url': `https://kite.zerodha.com/oms/instruments/historical/${order.instrument_token}/minute?from=${candleTime}&to=${candleTime2}`,
      'headers': {
        'X-Kite-Version': '3',
        'Authorization': 'enctoken ' + zerodha_token
      },
      json: true,
      keepAlive: true,
      gzip: true
    };
    request(options, async function (error, response) {
      if (error) throw new Error(error);
      // console.log(response.body);
      let close = response.body.data.candles[0][4];
      console.log(candleTime, order.tradingsymbol, order.tag, close);
      let resp = await setPrice(order.id, close);
      resolve(resp);
    });
  });
}

function setPrice(id, price) {
  return new Promise((resolve, reject) => {
    var options = {
      'method': 'PATCH',
      'url': 'https://algospot.in/api/paper-trades/' + id + '?access_token=' + lb_token,
      'headers': {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        "average_price": price
      })
    };
    request(options, function (error, response) {
      if (error) throw new Error(error);
      resolve(response.body);
    });
  })

}

async function init() {
  for (let i = 0; i < orders.length; i++) {
    let resp = await getPrice(orders[i]);
    console.log(JSON.parse(resp));
  }
}

init();
