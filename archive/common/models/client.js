'use strict';
const Zerodha = require('./../../server/lib/zerodha');
const async = require('async');
const moment = require('moment');

module.exports = function (Client) {
  delete Client.validations.email;

  // Client.disableRemoteMethodByName("create");
  Client.disableRemoteMethodByName("upsert");
  Client.disableRemoteMethodByName("replaceOrCreate");
  Client.disableRemoteMethodByName("createChangeStream");
  Client.disableRemoteMethodByName("upsertWithWhere");

  let strategies = ['STG7', 'STG6', 'STG34', 'Spider', 'Strangle', 'Bently', 'Tesla', 'LowRisk', 'Pi', 'AWS', 'SQF'];

  let position_cache = [];
  let lastRefreshTime = 0;
  Client.day_summary = function (options, cb) {
    (async () => {
      try {
        if (typeof options.accessToken != 'object' || typeof options.accessToken.userId == 'undefined') {
          cb(null, {
            status: false,
            message: 'user not logged in.'
          });
        } else {
          let clientId = options.accessToken.userId;
          let account = await Client.app.models.account.findOne({
            where: {
              clientId: clientId
            }
          });
          if (account) {
            let zapi_n = new Zerodha();
            zapi_n.loadConfig(account);
            let session = await zapi_n.checkSession();
            if (!session) await zapi_n.login();
            let positions = await zapi_n.positions();
            let orderbook = await zapi_n.orders();
            cb(null, {
              orders: orderbook,
              positions: positions.day,
              id: account.id,
              name: account.name,
              username: account.config.data.user_shortname,
              fullname: account.config.data.user_name,
            });
          } else {
            let XtsAccount = Client.app.models.xtsAccount;
            account = await XtsAccount.findOne({
              where: {
                clientId: clientId
              }
            });
            if (account) {
              let resp = {
                accountId: account.id,
                name: account.name,
                username: account.username,
                fullname: account.username,
                strategy: account.strategy,
                positions: [],
                orders: [],
                platform: 'xts'
              };
              try {
                let client = await XtsAccount.loginClient_v2(account.id);
                if (client) {
                  let positions = await XtsAccount.getPositions(client);
                  let orders = await XtsAccount.getOrders(client);
                  resp.positions = positions;
                  resp.orders = orders;
                  cb(null, resp);
                } else {
                  cb(null, resp);
                }
              } catch (err) {
                console.log(err);
                cb(null, resp);
              }
            } else {
              let Algouser = Client.app.models.algouser;
              account = await Algouser.findOne({
                where: {
                  clientId: clientId
                }
              });
              if (account) {
                Algouser.positions(account.id, cb);
              } else {
                cb(null, {
                  orders: [],
                  positions: [],
                  id: 'Not Found',
                  name: 'Not Found',
                  username: 'Not Found',
                  fullname: 'Not Found',
                });
              }
            }
          }
        }
      } catch (err) {
        console.log(err);
        cb(null, false);
      }
    })();
  };

  Client.remoteMethod("day_summary", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "options",
      type: "object",
      http: "optionsFromRequest"
    }],
    returns: {
      type: "object",
      root: true
    }
  });


  Client.squareOff = function (options, cb) {
    (async () => {
      try {
        if (typeof options.accessToken != 'object' || typeof options.accessToken.userId == 'undefined') {
          cb(null, {
            status: false,
            message: 'user not logged in.'
          });
        } else {
          let clientId = options.accessToken.userId;
          let Log = await Client.app.models.log;
          let account = await Client.app.models.account.findOne({
            where: {
              clientId: clientId
            }
          });
          if (account) {
            let zapi_n = new Zerodha();
            zapi_n.loadConfig(account);
            let session = await zapi_n.checkSession();
            if (!session) await zapi_n.login();
            Client.app.models.account.closePositions(zapi_n, async function (err, resp) {
              try {
                if (account.bkp_strategy == false) account.bkp_strategy = {};
                Object.keys(account.strategy).forEach(s => {
                  if (account.strategy[s] > 0) {
                    account.bkp_strategy[s] = account.strategy[s];
                    account.strategy[s] = 0;
                  }
                });
              } catch (err) {

              }
              await account.save();
              let logObj = {
                instance: account,
                userId: clientId,
                ts: new Date(),
                updated: "Account Square off Initiated"
              };
              Log.create(logObj);
              cb(null, {
                status: true
              });
            });
          } else {
            let XtsAccount = Client.app.models.xtsAccount;
            account = await XtsAccount.findOne({
              where: {
                clientId: clientId
              }
            });
            if (account) {
              Xtsaccount.squareOff(account.id, {}, cb);
            } else {
              cb(null, {
                status: false
              });
            }
          }
        }
      } catch (err) {
        console.log(err);
        cb(null, {
          status: false
        });
      }
    })();
  };

  Client.remoteMethod("squareOff", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "options",
      type: "object",
      http: "optionsFromRequest"
    }],
    returns: {
      type: "object",
      root: true
    }
  });

  Client.resetPin = function (clientId, cb) {
    Client.findById(clientId, function (err, user) {
      if (err) cb(null, {
        status: 404
      });
      user.updateAttribute('password', String(1212), function (err, user) {
        if (err) cb(null, {
          status: 404
        });
        cb(null, {
          status: 200
        });
      });
    });
  };

  Client.remoteMethod("resetPin", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "clientId",
      type: "string"
    }],
    returns: {
      type: "object",
      root: true
    }
  });
};
