'use strict';

const debounce = require('./../lib/debounce');
const async = require('async');
const { resolveFill } = require('./../lib/fill-price');
const Zerodha = require('./../lib/zerodha');
const kiteTicker = require('./../lib/KiteTicker');
const optionConfig = require('./../tools/optionInstruments');
// const futuresConfig = require('../tools/futureInstruments');
const notify = require('./../lib/notify');
const CronJob = require("cron").CronJob;
const fs = require('fs');

module.exports = function (app) {
  let ticksCache = {};
  let slippage = 0;
  let ticksCacheFrontend = {};
  let symbolTokenMap = {};

  if (require.main.filename.replace(require.main.path + '/', '') === 'server.js') {
    const Link = require('./../tools/process-link');
    Link.on('connect', function () {
      console.log('Link Connected');
      Link.emit('join_room', 'BSE');
    });
    Link.on('tracker', function (data) {
      app.io.emit('bse_tracker', data);
    });
  }

  let xtsAccountDetails = [];
  let rejectedOrdersSet = new Set();
  let cancelledOrdersSet = new Set();
  try {
    if (fs.existsSync('cancelledOrders.json')) {
      let tmpOrderIds = JSON.parse(fs.readFileSync('cancelledOrders.json', 'utf8'));
      cancelledOrdersSet = new Set(tmpOrderIds);
    }
  } catch (err) {
    console.log(err);
  }
  try {
    if (fs.existsSync('rejectedOrders.json')) {
      let tmpOrderIds = JSON.parse(fs.readFileSync('rejectedOrders.json', 'utf8'));
      rejectedOrdersSet = new Set(tmpOrderIds);
    }
  } catch (err) {
    console.log(err);
  }
  let base_account, zapi_base = new Zerodha();

  function start(socket) {
    app.io.emit('online', app.io.of("/").sockets.size);

    socket.on('disconnect', () => {
      app.io.emit('online', app.io.of("/").sockets.size);
    });

    socket.on('get_ticks', () => {
      socket.emit('ticks', ticksCacheFrontend);
    });
  }

  function sendUpdatePnl() {
    let Account = app.models.account;
    let OrderBook = app.models.orderbook;

    Account.all_positions(true, function (err, resp) {
      let currentRejectedOrders = [];
      let currentCancelledOrders = [];
      async.eachLimit(resp, 10, function (accountPosition, cb) {
        // Single pass filter for both rejected and cancelled orders
        const orders = accountPosition.orders;
        const accountId = accountPosition.accountId;
        for (let i = 0, len = orders.length; i < len; i++) {
          const order = orders[i];
          const status = order.status;
          if (status === 'REJECTED' || status === 'Rejected') {
            order.accountId = accountId;
            currentRejectedOrders.push(order);
          } else if (status === 'CANCELLED' || status === 'Cancelled') {
            order.accountId = accountId;
            currentCancelledOrders.push(order);
          }
        }
        OrderBook.upsertWithWhere({
          createdAt: accountPosition.createdAt,
          accountId: accountId
        }, accountPosition, cb);
      }, function () {
        let msgtext2 = '';
        let msgtext = '';
        let newCancelledOrders = [];
        let newRejectedOrders = [];

        // Process cancelled orders - collect new ones first
        for (let i = 0, len = currentCancelledOrders.length; i < len; i++) {
          const order = currentCancelledOrders[i];
          if (!cancelledOrdersSet.has(order.order_id)) {
            msgtext2 += `${order.placed_by} - ${order.tag} - ${order.status_message_raw === '17070 : The Price is out of the current execution range' ? 'Option Freeze' : order.status_message}\n`;
            cancelledOrdersSet.add(order.order_id);
            newCancelledOrders.push(order);
          }
        }

        // Retry cancelled orders in parallel with limit
        if (newCancelledOrders.length > 0) {
          setTimeout(function () {
            async.eachLimit(newCancelledOrders, 3, function (order, orderCb) {
              Account.orderFNO(String(order.accountId), {
                "tradingsymbol": order.tradingsymbol,
                "transaction_type": order.transaction_type,
                "order_type": "MARKET",
                "quantity": order.quantity,
                "trigger_price": 0,
                "price": 0,
                "tag": order.tag
              }, function (err, order_resp) {
                console.log(order_resp);
                orderCb();
              });
            }, function () {
              d_sendUpdatePnl();
            });
          }, 5000);
        }
        if (msgtext2.length > 0) {
          notify(msgtext2, 0);
        }
        fs.writeFile('cancelledOrders.json', JSON.stringify([...cancelledOrdersSet]), function () {});

        // Process rejected orders
        for (let i = 0, len = currentRejectedOrders.length; i < len; i++) {
          const order = currentRejectedOrders[i];
          if (!rejectedOrdersSet.has(order.order_id)) {
            msgtext += `${order.placed_by} - ${order.tag} - ${order.status_message.indexOf('Insufficient funds') !== -1 ? 'Insufficient funds' : order.status_message}\n`;
            rejectedOrdersSet.add(order.order_id);
            newRejectedOrders.push(order);
          }
        }

        // Square off rejected orders in parallel
        async.eachLimit(newRejectedOrders, 3, function (order, sqfCb) {
            // closePositions(zapi_n, cb2, strategy)
          Account.squareOff(String(order.accountId), {
            accessToken: {
              userId: "sysadmin"
            }
          }, function () {
            console.log('rejection sqf done', order);
            sqfCb();
          });
        }, function () {
          if (msgtext.length > 0) {
            notify(msgtext, 0);
          }
          fs.writeFile('rejectedOrders.json', JSON.stringify([...rejectedOrdersSet]), function () {});
        });
        // console.log('Positions Saved!');
        app.io.emit("positions-update", true);
      });
    });
  }

  function sendUpdate() {
    let PaperTrade = app.models.PaperTrade;
    PaperTrade.positions(function (err, resp) {
      app.io.emit("paper-update", resp);
    });
  }

  let fetchOrderStatusRunning = false;

  function fetchOrderStatus() {
    if (fetchOrderStatusRunning) {
      return;
    }
    if (xtsAccountDetails.length === 0) {
      return;
    }
    fetchOrderStatusRunning = true;
    let XtsAccount = app.models.xtsAccount;
    async.eachLimit(xtsAccountDetails, 5, function (account, cb) {
      XtsAccount.backfill_orderbook(String(account.id), function (err, resp) {
        cb();
      });
    }, function () {
      fetchOrderStatusRunning = false;
      app.io.emit("positions-update", true);
    });
  }

  let d_fetchOrderStatus = debounce(fetchOrderStatus, 3000);
  let d_sendUpdate = debounce(sendUpdate, 3000);
  // let d_sendUpdatePnl = debounce(sendUpdatePnl, 3000);

  let liveFeed, public_token;
  async function ticker(subs) {
    liveFeed = new kiteTicker({
      api_key: 'kitefront',
      access_token: public_token
    });
    liveFeed.connect();
    liveFeed.on("ticks", storeTicks);
    liveFeed.on("connect", function () {
      console.log('PT: Banknifty Live Feed Connected');
      liveFeed.subscribe(subs);
      liveFeed.setMode(liveFeed.modeFull, subs);
    });
  }
  let liveFeed_n;
  async function ticker_n(subs) {
    liveFeed_n = new kiteTicker({
      api_key: 'kitefront',
      access_token: public_token
    });
    liveFeed_n.connect();
    liveFeed_n.on("ticks", storeTicks);
    liveFeed_n.on("connect", function () {
      console.log('PT: Nifty Live Feed Connected');
      liveFeed_n.subscribe(subs);
      liveFeed_n.setMode(liveFeed_n.modeFull, subs);
    });
  }
  let liveFeed_m;
  async function ticker_m(subs) {
    liveFeed_m = new kiteTicker({
      api_key: 'kitefront',
      access_token: public_token
    });
    liveFeed_m.connect();
    liveFeed_m.on("ticks", storeTicks);
    liveFeed_m.on("connect", function () {
      console.log('PT: MIDCPNIFTY Live Feed Connected');
      console.log(subs);
      liveFeed_m.subscribe(subs);
      liveFeed_m.setMode(liveFeed_m.modeFull, subs);
    });
  }
  let liveFeed_fn;
  async function ticker_fn(subs) {
    liveFeed_fn = new kiteTicker({
      api_key: 'kitefront',
      access_token: public_token
    });
    liveFeed_fn.connect();
    liveFeed_fn.on("ticks", storeTicks);
    liveFeed_fn.on("connect", function () {
      console.log('PT: FINNIFTY Live Feed Connected');
      console.log(subs);
      liveFeed_fn.subscribe(subs);
      liveFeed_fn.setMode(liveFeed_m.modeFull, subs);
    });
  }

  let liveFeed_sn;
  async function ticker_sn(subs) {
    liveFeed_sn = new kiteTicker({
      api_key: 'kitefront',
      access_token: public_token
    });
    liveFeed_sn.connect();
    liveFeed_sn.on("ticks", storeTicks);
    liveFeed_sn.on("connect", function () {
      console.log('PT: SENSEX Live Feed Connected');
      console.log(subs);
      liveFeed_sn.subscribe(subs);
      liveFeed_sn.setMode(liveFeed_sn.modeFull, subs);
    });
  }

  function storeTicks(ticks) {
    // Single loop to update both caches
    const ticksFrontend = {};
    for (let i = 0, len = ticks.length; i < len; i++) {
      const tick = ticks[i];
      const token = tick.instrument_token;
      ticksCache[token] = tick;
      ticksFrontend[token] = tick.last_price;
      ticksCacheFrontend[token] = tick.last_price;
    }
    app.io.emit('ticks', ticksFrontend);
  }

  async function startSocket() {
    let masterId = app.get('masterId');
    if (app.get('slippage')) {
      slippage = app.get('slippage');
      console.log('Adding slippage: ', slippage);
    }
    let Account = app.models.account;
    console.log('Starting Paper Trading LiveSocket');
    if (!base_account) {
      base_account = await Account.findById(masterId);
      zapi_base.loadConfig(base_account);
      await zapi_base.login();
      public_token = zapi_base.getAuthorization();
      setToken(public_token);
    }
    let optionData = await optionConfig.download('BANKNIFTY');
    // let futureData = await futuresConfig();
    // let future_all_tokens = Object.values(futureData).map(c => c.instrument_token);
    let futureToken = optionData.currentFuture.token;
    let currentExpiryOptions = optionData.weeklyInstruments;
    let b_currentExpiryOptions = optionData.nextWeekInstruments;
    let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);
    let b_optionTokens = Object.values(b_currentExpiryOptions).map(c => c.instrument_token);

    let n_optionData = await optionConfig.download('NIFTY');
    let n_futureToken = n_optionData.currentFuture.token;
    let n_currentExpiryOptions = n_optionData.weeklyInstruments;
    let n_nextWeekExpiryOptions = n_optionData.nextWeekInstruments;
    let n_optionTokens = Object.values(n_currentExpiryOptions).map(c => c.instrument_token);
    let n_nextWeekOptionTokens = Object.values(n_nextWeekExpiryOptions).map(c => c.instrument_token);

    // let m_optionData = await optionConfig.download('MIDCPNIFTY');
    // let m_futureToken = m_optionData.currentFuture.token;
    // let m_currentExpiryOptions = m_optionData.weeklyInstruments;
    // let m_nextWeekExpiryOptions = m_optionData.nextWeekInstruments;
    // let m_optionTokens = Object.values(m_currentExpiryOptions).map(c => c.instrument_token);
    // let m_nextWeekOptionTokens = Object.values(m_nextWeekExpiryOptions).map(c => c.instrument_token);

    // let fn_optionData = await optionConfig.download('FINNIFTY');
    // let fn_futureToken = fn_optionData.currentFuture.token;
    // let fn_currentExpiryOptions = fn_optionData.weeklyInstruments;
    // let fn_nextWeekExpiryOptions = fn_optionData.nextWeekInstruments;
    // let fn_optionTokens = Object.values(fn_currentExpiryOptions).map(c => c.instrument_token);
    // let fn_nextWeekOptionTokens = Object.values(fn_nextWeekExpiryOptions).map(c => c.instrument_token);

    let sn_optionData = await optionConfig.download('SENSEX');
    let sn_futureToken = sn_optionData.currentFuture.token;
    let sn_currentExpiryOptions = sn_optionData.weeklyInstruments;
    let sn_nextWeekExpiryOptions = sn_optionData.nextWeekInstruments;
    let sn_optionTokens = Object.values(sn_currentExpiryOptions).map(c => c.instrument_token);
    let sn_nextWeekOptionTokens = Object.values(sn_nextWeekExpiryOptions).map(c => c.instrument_token);

    for (const data of [optionData, n_optionData, sn_optionData]) {
      for (const inst of [...Object.values(data.weeklyInstruments), ...Object.values(data.nextWeekInstruments)]) {
        symbolTokenMap[inst.tradingsymbol] = inst.instrument_token;
      }
      if (data.currentFuture.symbol) symbolTokenMap[data.currentFuture.symbol] = data.currentFuture.token;
    }

    ticker([256265, 260105, 265, futureToken, ...optionTokens, ...b_optionTokens]);
    ticker_n([n_futureToken, ...n_optionTokens, ...n_nextWeekOptionTokens]);
    ticker_sn([sn_futureToken, ...sn_optionTokens, ...sn_nextWeekOptionTokens]);
    // ticker_m([m_futureToken, ...m_optionTokens, ...m_nextWeekOptionTokens]);
    // ticker_fn([fn_futureToken, ...fn_optionTokens, ...fn_nextWeekOptionTokens]);
    // ticker_f(future_all_tokens);
  }

  async function handleInsertEvent(model, event, bidAsk = 0) {
    const optionInstrument = event.fullDocument;
    if (optionInstrument.status !== 'COMPLETE') return;

    const orderTimestamp = new Date();
    const instrumentId = optionInstrument._id;

    // If price is provided, use it directly
    if (optionInstrument.price) {
      model.updateAll({ _id: instrumentId }, {
        average_price: optionInstrument.price,
        order_timestamp: orderTimestamp,
      });
      return;
    }

    // Get market price from tick cache (falls back to tradingsymbol lookup
    // for orders that arrive without a Kite instrument_token)
    const { price, token } = resolveFill(optionInstrument, ticksCache, symbolTokenMap, bidAsk, slippage);

    const update = {
      average_price: price,
      order_timestamp: orderTimestamp,
    };
    if (token && token !== optionInstrument.instrument_token) update.instrument_token = token;

    model.updateAll({ _id: instrumentId }, update);
  }

  app.token = false;

  function setToken(token) {
    app.token = token;
  }

  function regenerateTokens() {
    let XtsAccount = app.models.xtsAccount;
    console.log('Clearing old XTS tokens');
    XtsAccount.updateAll({
      token: false
    }, function () {
      XtsAccount.all_positions(true, function () {
        console.log('Relogin Done');
      });
    });
  }

  app.on('started', function () {
    let PaperTrade = app.models.PaperTrade;
    let Positional = app.models.positional;
    let Algopaper = app.models.algopaper;
    let XtsAccount = app.models.xtsAccount;
    if (require.main.filename.replace(require.main.path + '/', '') === 'server.js' && !process.env.SMOKE_BOOT) {
      startSocket();
      console.log('Started LiveSocket');
      XtsAccount.find({}, function (err, accounts) {
        if (accounts.length > 0) {
          console.log('Found XTS accounts');
          xtsAccountDetails = accounts;
        }
      });
      PaperTrade.getDataSource().connector.connect(function (err, db) {
        console.log('datasource connected');
        const collection = db.collection("paper-trade");
        const collection2 = db.collection("positional");
        const collection3 = db.collection("algopaper");
        const changeStream = collection.watch();
        const changeStream2 = collection2.watch();
        const changeStream3 = collection3.watch();
        changeStream3.on("change", function (event) {
          try {
            if (event.operationType == 'insert') handleInsertEvent(Algopaper, event, 4);
          } catch (err) {
            console.log(err);
          }
        });
        changeStream2.on("change", function (event) {
          try {
            if (event.operationType == 'insert') handleInsertEvent(Positional, event);
            if (event.fullDocument && event.fullDocument.tag) {
              d_sendUpdate();
            }
          } catch (err) {
            console.log(err);
          }
        });
        changeStream.on("change", function (event) {
          try {
            if (event.operationType == 'insert') handleInsertEvent(PaperTrade, event, 4);
            if (event.fullDocument && event.fullDocument.tag) {
              d_fetchOrderStatus();
              d_sendUpdate();
              // d_sendUpdatePnl();
            }
          } catch (err) {
            console.log(err);
          }
        });
      });
      app.io.on('connection', start);
      new CronJob('15 * 9-15 * * 1-5', sendUpdatePnl, null, true, 'Asia/Kolkata');
      new CronJob('0 30 7 * * 1-5', function () {
        optionConfig.download('BANKNIFTY');
        optionConfig.download('NIFTY');
        optionConfig.download('SENSEX');
      }, null, true, 'Asia/Kolkata');
      new CronJob('0 45 8 * * 1-5', function () {
        // Clear Sets and reset files
        cancelledOrdersSet.clear();
        rejectedOrdersSet.clear();
        fs.writeFile('cancelledOrders.json', "[]", function () {});
        fs.writeFile('rejectedOrders.json', "[]", function () {});
        // notify('Restarting Server...', 0);
        let PT = app.models.PaperTrade;
        let clearStrategies = ['Lion_0020', 'Lion_M6000', 'Lion_S25_1', 'Lion_S25_2', 'Lion_S25_3', 'BigLion_0020', 'JK_0020', 'JK_SBM95', 'Lion_1789', 'Cheetah_0042', 'Cheetah_2204', "STGL-Mid-0020-1", "STGL-Mid-0020-2", "STGL-Mid-0020-3", "STGL-Mid-0020-4", "STGL-Mid-2117-1", "STGL-Mid-2117-2", "STGL-Mid-2117-3", "STGL-Mid-2117-4", "Lion_ZZJ11574", "P718-4"];
        PT.destroyAll({
          tag: {
            inq: clearStrategies
          }
        });
        const Orderbook2 = app.models.orderbook2;
        Orderbook2.destroyAll({});
        setTimeout(function () {
          process.exit();
        }, 3000);
      }, null, true, 'Asia/Kolkata');
      new CronJob('0 30 8 * * 1-5', regenerateTokens, null, true, 'Asia/Kolkata');
      new CronJob('0 0 9 * * 1-5', regenerateTokens, null, true, 'Asia/Kolkata');
      new CronJob('0 10 9 * * 1-5', regenerateTokens, null, true, 'Asia/Kolkata');
    }
  });
};
