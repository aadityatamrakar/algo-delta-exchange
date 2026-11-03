'use strict';

var loopback = require('loopback');
var boot = require('loopback-boot');
var events = require('events');
var telegram = require('./lib/notify');
const uuidv1 = require('uuid');
var morgan = require('morgan');
var path = require('path');
var rfs = require('rotating-file-stream');
var accessLogStream = rfs.createStream('access.log', {
  interval: '1d',
  path: path.join(__dirname, 'log')
});
const rateLimit = require("express-rate-limit");
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  onLimitReached: function (req, res, options) {
    let ipAddress = req.headers['x-forwarded-for'] ||
      req.connection.remoteAddress ||
      req.socket.remoteAddress ||
      (req.connection.socket ? req.connection.socket.remoteAddress : null);
    let msg = "IP: " + ipAddress + "\n" + "URL: " + req.url + "\n" + JSON.stringify(req.headers) + "\n";
    telegram('IP Limit Exceeded: ' + ipAddress, 0);
    fs.appendFileSync('ratelimit', msg);
  },
  keyGenerator: function (req) {
    let ipAddress = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] ||
      req.connection.remoteAddress ||
      req.socket.remoteAddress ||
      (req.connection.socket ? req.connection.socket.remoteAddress : req.ip);
    return ipAddress;
  }
});

var app = module.exports = loopback();
app.flow = new events.EventEmitter();

app.start = function () {
  // app.use(function (req, res, next) {
  //   if (req.secure) {
  //     next();
  //   } else {
  //     res.redirect('https://' + req.headers.host + req.url);
  //   }
  // });
  app.set('trust proxy', true);
  app.use('/api/', limiter);
  app.use(morgan('combined', {
    stream: accessLogStream
  }));

  // start the web server
  return app.listen(function () {
    app.emit('started');
    var baseUrl = app.get('url').replace(/\/$/, '');
    console.log('Web server listening at: %s', baseUrl);
    if (app.get('loopback-component-explorer')) {
      var explorerPath = app.get('loopback-component-explorer').mountPath;
      console.log('Browse your REST API at %s%s', baseUrl, explorerPath);
    }
  });
};

// Bootstrap the application, configure models, datasources and middleware.
// Sub-apps like REST API are mounted via boot scripts.
boot(app, __dirname, function (err) {
  if (err) throw err;

  // start the server if `$ node server.js`
  if (require.main === module) {
    //Comment this app.start line and add following lines
    //app.start();
    app.io = require('socket.io')(app.start());
    app.connected = [];

    app.io.engine.generateId = (req) => {
      if (req._query && req._query.userId) {
        return req._query.userId;
      } else return uuidv1();
    }

    app.io
      .use(function (socket, next) {
        if (socket.handshake && socket.handshake.query) {
          let tokenId = socket.handshake.query.token ? socket.handshake.query.token : false;
          let userId = socket.handshake.query.userId ? socket.handshake.query.userId : false;
          if (tokenId && userId) {
            let AccessToken = app.models.AccessToken;
            AccessToken.findById(tokenId, function (err, token) {
              if (err) next(new Error('INVALID_TOKEN'));
              else if (token && token.userId == userId) next()
              else next(new Error('INVALID_TOKEN'));
            })
          } else next(new Error('INVALID_TOKEN'));
        } else next(new Error('INVALID_TOKEN'));
      });
  }
});
