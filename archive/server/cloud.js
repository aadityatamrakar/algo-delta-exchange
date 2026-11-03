'use strict';

const loopback = require('loopback');
const boot = require('loopback-boot');
const https = require('https');
const sslConfig = require('./ssl-config');

const app = module.exports = loopback();

boot(app, __dirname);

app.start = function () {
  let httpsServer;
  const options = {
    key: sslConfig.privateKey,
    cert: sslConfig.certificate,
  };
  httpsServer = https.createServer(options, app);
  httpsServer.listen(443, function () {
    console.log('Server started')
  });
  return httpsServer;
};

// start the server if `$ node server.js`
if (require.main === module) {
  app.start();
}

