const request = require("request");
const qs = require('querystring');
const fs = require('fs');
const FileCookieStore = require('tough-cookie-filestore');

class Fyers {

  constructor(account) {
    if (typeof account == 'object') this.loadConfig(account);
  }

  loadConfig(account) {
    this.credentials = account.credentials;
  }

  async login() {
    let self = this;
    let sessionActive = await self.checkSession();
    return new Promise((resolve, reject) => {
      if (sessionActive) {
        // console.log(self.credentials.user_id + ': Session Active.');
        resolve(true);
      } else {
        var options = {
          'method': 'POST',
          'url': 'https://api.fyers.in/vagator/v1/login',
          body: {
            app_id: "2",
            fy_id: self.credentials.user_id,
            imei: "",
            password: self.credentials.password,
            recaptcha_token: ""
          },
          json: true
        };

        request(options, function (error, response, body) {
          if (error) {
            console.log(error);
            resolve(false);
          }
          if (body.s == 'ok' && body.code == 2 && body.pin_created && body.request_key) {

            var options = {
              'method': 'POST',
              'url': 'https://api.fyers.in/vagator/v1/verify_pin',
              body: {
                identifier: self.credentials.pan_dob,
                identity_type: "pin",
                recaptcha_token: "",
                request_key: body.request_key
              },
              json: true
            };

            request(options, function (error, response, body) {
              if (error) {
                console.log(error);
                resolve(false);
              }
              if (body.s == 'ok' && body.code == 1004) {
                self.credentials.token = body.data.access_token;
                resolve(true);
              } else resolve(false);
            });
          } else resolve(false);
        });
      }
    })
  }

  randomString() {
    for (var e = "", t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", a = 0; a < 32; a++)
      e += t.charAt(Math.floor(Math.random() * t.length));
    return e
  }

  async checkSession() {
    let self = this;
    return new Promise((resolve, reject) => {
      if (self.credentials.token) {
        var options = {
          'method': 'GET',
          'url': 'https://api.fyers.in/vagator/v1/verify_token',
          'headers': {
            'authorization': { "access_token": self.credentials.token, "app_id": 2 }
          },
          json: true
        };
        request(options, function (error, response, body) {
          if (error) {
            console.log(error);
            resolve(false);
          }
          if (body.s == 'ok') resolve(true);
        });
      } else resolve(false);
    })
  }

  async place_order(options) {
    let self = this;

    return new Promise((resolve, reject) => {
      var req_options = {
        method: 'POST',
        url: 'https://api.fyers.in/fydev/v1/orders',
        headers: {
          'Cookie': self.credentials.token
        },
        json: true,
        body: {
          "noConfirm": true,
          "productType": options.product || 'INTRADAY', // CNC,INTRADAY,MARGIN,CO,BO
          /* 1 => Buy, -1 => Sell */
          "side": options.side,
          "symbol": options.symbol, // NSE:BANKNIFTY2160335500PE
          "qty": options.quantity, // quantity = 25
          "disclosedQty": 0,
          /* 1 => Limit Order, 2 => Market Order, 3 => Stop Order (SL-M), 4 => Stoplimit Order (SL-L) */
          "type": 2,
          "validity": "DAY",
          "filledQty": 0,
          "limitPrice": 0, // valid for Limit and SL Limit
          "stopPrice": 0, // valid for stop and stop limit
          "offlineOrder": false
        }
      };

      request(req_options, function (error, response, body) {
        if (body.s == 'ok') {
          resolve(body);
        } else {
          console.log(body);
          resolve(false);
        }
      });
    })
  }

  async orders() {
    let self = this;
    return new Promise((resolve, reject) => {
      var options = {
        method: 'GET',
        url: 'https://api.fyers.in/fydev/v1/orders',
        headers: {
          Connection: 'keep-alive',
          'Cookie': self.credentials.token,
          authorization: self.credentials.token
        },
        gzip: true,
        json: true
      };

      request(options, function (error, response, body) {
        if (error) reject(error);
        try {
          body = body.orderBook;
          resolve(body);
        } catch (err) {
          reject(err);
          console.log(err);
        }
      });
    });
  }

  async positions() {
    let self = this;
    return new Promise((resolve, reject) => {
      var options = {
        method: 'GET',
        url: 'https://api.fyers.in/fydev/v1/positions',
        headers: {
          Connection: 'keep-alive',
          'Cookie': self.credentials.token,
          authorization: self.credentials.token
        },
        gzip: true,
        json: true
      };

      request(options, function (error, response, body) {
        if (error) reject(error);
        try {
          body = body.netPositions;
          resolve(body);
        } catch (err) {
          reject(err);
          console.log(err);
        }
      });
    });
  }

  async funds() {
    let self = this;
    return new Promise((resolve, reject) => {
      var options = {
        method: 'GET',
        url: 'https://api.fyers.in/fydev/v1/funds',
        headers: {
          Connection: 'keep-alive',
          'Cookie': self.credentials.token,
          authorization: self.credentials.token
        },
        gzip: true,
        json: true
      };

      request(options, function (error, response, body) {
        if (error) reject(error);
        try {
          body = body.fund_limit;
          body = body.reduce((obj, elm) => (obj[elm.title] = elm.equityAmount, obj), {})
          resolve(body);
        } catch (err) {
          reject(err);
          console.log(err);
        }
      });
    });
  }

  getToken() {
    let self = this;
    try {
      return self.credentials.token || false;
    } catch (e) {
      return false;
    }
  }
};

module.exports = Fyers;
