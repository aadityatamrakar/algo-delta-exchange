const app = require('../server/server.js');
const zerodha = require('../server/lib/zerodha.js');
const Stoch = require('../server/lib/indicators/stoch.js');
const Account = app.models.account;
const tranches = (number) => ((new Array(Math.floor(number / 100)).fill(100).concat(number % 100)).filter(c => c > 0));
const CronJob = require("cron").CronJob;
const optionConfig = require('../server/tools/optionInstruments');

let zapi;

async function zerodha_init(account) {
  let zapi_n = new zerodha();
  zapi_n.loadConfig(account);
  let login_resp = await zapi_n.login();
  account.lastLogin = (new Date()).toISOString().substr(0, 10);
  account.config = await zapi_n.getConfig();
  await account.save();
  if (login_resp === false) return false;
  else return zapi_n;
}

let fs = require('fs');
async function init() {
  try {
    let base_acc = await Account.findById("601d0533e84b793c322b1e67");
    zapi = await zerodha_init(base_acc);
    let data, combine_data = [];
    
    // data = await zapi.historyData(260105, '5minute', '2018-01-01', '2018-01-30');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2018-01-01', '2018-01-30');
    // data = await zapi.historyData(260105, '5minute', '2018-02-01', '2018-02-28');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2018-02-01', '2018-02-30');
    // data = await zapi.historyData(260105, '5minute', '2018-03-01', '2018-03-31');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2018-03-01', '2018-03-31');
    // data = await zapi.historyData(260105, '5minute', '2018-04-01', '2018-04-30');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2018-04-01', '2018-04-30');
    // data = await zapi.historyData(260105, '5minute', '2018-05-01', '2018-05-31');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2018-05-01', '2018-05-31');
    // data = await zapi.historyData(260105, '5minute', '2018-06-01', '2018-06-30');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2018-06-01', '2018-06-30');
    // data = await zapi.historyData(260105, '5minute', '2018-07-01', '2018-07-31');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2018-07-01', '2018-07-31');
    // data = await zapi.historyData(260105, '5minute', '2018-08-01', '2018-08-31');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2018-08-01', '2018-08-31');
    // data = await zapi.historyData(260105, '5minute', '2018-09-01', '2018-09-30');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2018-09-01', '2018-09-30');
    // data = await zapi.historyData(260105, '5minute', '2018-10-01', '2018-10-31');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2018-10-01', '2018-10-31');
    // data = await zapi.historyData(260105, '5minute', '2018-11-01', '2018-11-30');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2018-11-01', '2018-11-30');
    // data = await zapi.historyData(260105, '5minute', '2018-12-01', '2018-12-31');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2018-12-01', '2018-12-31');

    // data = await zapi.historyData(260105, '5minute', '2019-01-01', '2019-01-30');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2019-01-01', '2019-01-30');
    // data = await zapi.historyData(260105, '5minute', '2019-02-01', '2019-02-28');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2019-02-01', '2019-02-30');
    // data = await zapi.historyData(260105, '5minute', '2019-03-01', '2019-03-31');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2019-03-01', '2019-03-31');
    // data = await zapi.historyData(260105, '5minute', '2019-04-01', '2019-04-30');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2019-04-01', '2019-04-30');
    // data = await zapi.historyData(260105, '5minute', '2019-05-01', '2019-05-31');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2019-05-01', '2019-05-31');
    // data = await zapi.historyData(260105, '5minute', '2019-06-01', '2019-06-30');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2019-06-01', '2019-06-30');
    // data = await zapi.historyData(260105, '5minute', '2019-07-01', '2019-07-31');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2019-07-01', '2019-07-31');
    // data = await zapi.historyData(260105, '5minute', '2019-08-01', '2019-08-31');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2019-08-01', '2019-08-31');
    // data = await zapi.historyData(260105, '5minute', '2019-09-01', '2019-09-30');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2019-09-01', '2019-09-30');
    // data = await zapi.historyData(260105, '5minute', '2019-10-01', '2019-10-31');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2019-10-01', '2019-10-31');
    // data = await zapi.historyData(260105, '5minute', '2019-11-01', '2019-11-30');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2019-11-01', '2019-11-30');
    // data = await zapi.historyData(260105, '5minute', '2019-12-01', '2019-12-31');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2019-12-01', '2019-12-31');

    // data = await zapi.historyData(260105, '5minute', '2020-01-01', '2020-01-30');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2020-01-01', '2020-01-30');
    // data = await zapi.historyData(260105, '5minute', '2020-02-01', '2020-02-29');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2020-02-01', '2020-02-29');
    // data = await zapi.historyData(260105, '5minute', '2020-03-01', '2020-03-31');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2020-03-01', '2020-03-31');
    // data = await zapi.historyData(260105, '5minute', '2020-04-01', '2020-04-30');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2020-04-01', '2020-04-30');
    // data = await zapi.historyData(260105, '5minute', '2020-05-01', '2020-05-31');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2020-05-01', '2020-05-31');
    // data = await zapi.historyData(260105, '5minute', '2020-06-01', '2020-06-30');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2020-06-01', '2020-06-30');
    // data = await zapi.historyData(260105, '5minute', '2020-07-01', '2020-07-31');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2020-07-01', '2020-07-31');
    // data = await zapi.historyData(260105, '5minute', '2020-08-01', '2020-08-31');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2020-08-01', '2020-08-31');
    // data = await zapi.historyData(260105, '5minute', '2020-09-01', '2020-09-30');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2020-09-01', '2020-09-30');
    // data = await zapi.historyData(260105, '5minute', '2020-10-01', '2020-10-31');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2020-10-01', '2020-10-31');
    // data = await zapi.historyData(260105, '5minute', '2020-11-01', '2020-11-30');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2020-11-01', '2020-11-30');
    // data = await zapi.historyData(260105, '5minute', '2020-12-01', '2020-12-31');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2020-12-01', '2020-12-31');

    // data = await zapi.historyData(260105, '5minute', '2021-01-01', '2021-01-30');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2021-01-01', '2021-01-30');
    // data = await zapi.historyData(12428290, '5minute', '2021-02-01', '2021-03-10');
    // combine_data = combine_data.concat(data);
    // console.log('Downloaded', '2021-02-01', '2021-02-15');
    // console.log(combine_data);

    data = await Stoch(data, 14);
    fs.writeFileSync('bn2.json', JSON.stringify(combine_data));
  } catch (err) {
    console.log(err);
  }
  // let optionData = await optionConfig();
  // futureToken = optionData.currentFuture.token;
  // currentExpiryOptions = optionData.weeklyInstruments;
  // console.log(futureToken, currentExpiryOptions['34800CE']);
  // Account.trackOrder(currentExpiryOptions['34800CE'], 'BUY', 'LowRisk');

  // new CronJob('*/10 * * * * *', async function () {
  //   let bn_quote;
  //   let checkQuote_attempt = 10;
  //   do {
  //     try {
  //       checkQuote_attempt--;
  //       bn_quote = await zapi.getQoute(12680706);
  //       console.log(bn_quote.last_price, zapi.getAuthorization());
  //     } catch (err) {
  //       // console.log(err);
  //       await zapi.login();
  //     }
  //   } while (typeof bn_quote != 'object' && checkQuote_attempt > 0);
  // }, null, true, 'Asia/Kolkata');

  // await zapi.orderFNO({
  //   tradingsymbol: 'HDFCBANK20DECFUT',
  //   transaction_type: 'SELL',
  //   order_type: "SL-M",
  //   quantity: 1100,
  //   trigger_price: 1402,
  //   price: 0,
  //   tag: 'BullRun'
  // });
}

init();
