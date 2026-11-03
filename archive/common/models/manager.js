'use strict';
const pm2 = require('pm2');
const async = require('async');

module.exports = function (Manager) {

  if (require.main.filename.replace(require.main.path + '/', '') === 'server.js' ||
    require.main.filename.replace(require.main.path + '/', '') === 'xtsOrder.js') {
    pm2.connect(function (err) {
      if (err) {
        console.error("PM2 Err:", err);
      }
      console.log('PM2 Connected');
    });
  }

  Manager.status = function (name, cb) {
    pm2.describe(name, (err, desc) => {
      if (err) {
        cb(null, {
          status: "ERR: " + err.message
        });
      } else {
        if (desc.length > 0) {
          cb(null, {
            status: desc[0].pm2_env.status
          });
        } else {
          cb(null, {
            status: 'not found'
          });
        }
      }
    })
  };

  Manager.remoteMethod("status", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "name",
      type: "string"
    }],
    returns: {
      type: "object",
      root: true
    }
  });

  Manager.restart = function (name, cb) {
    pm2.restart(name, err => {
      cb(null, {
        status: err
      })
    });
  };

  Manager.remoteMethod("restart", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "name",
      type: "string"
    }],
    returns: {
      type: "object",
      root: true
    }
  });

  Manager.stop = function (name, cb) {
    pm2.stop(name, err => {
      cb(null, {
        status: err
      })
    });
  };

  Manager.remoteMethod("stop", {
    http: {
      verb: "post"
    },
    accepts: [{
      arg: "name",
      type: "string"
    }],
    returns: {
      type: "object",
      root: true
    }
  });

  /*
  {
    name: "Lion_0020",
    module: "lion-0020"
  }, 
  */

  Manager.liveStrategies = require('./strategies.json');

  Manager.list = function (cb) {
    async.mapSeries(Manager.liveStrategies, function (strategy, cb) {
      pm2.describe(strategy.module, (err, desc) => {
        if (err) {
          strategy.status = "ERR: " + err.message;
          cb(null, strategy);
        } else {
          if (desc.length > 0) {
            strategy.status = desc[0].pm2_env.status;
            cb(null, strategy);
          } else {
            strategy.status = 'not found';
            cb(null, strategy);
          }
        }
      });
    }, function (err, resp) {
      cb(null, resp);
    });
  };

  Manager.remoteMethod("list", {
    http: {
      verb: "post"
    },
    accepts: [],
    returns: {
      type: "array",
      root: true
    }
  });
};
