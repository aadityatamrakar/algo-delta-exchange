const debug = require('debug')('tradelab');
const request = require("request");
const qs = require('querystring');
const fs = require('fs');
const FileCookieStore = require('tough-cookie-filestore');

class Tradelab {

  constructor(account, baseUrl = 'https://spark.jainam.in') {
    if (typeof account == 'object') this.loadConfig(account);
    this.baseUrl = baseUrl;
  }

  loadConfig(account) {
    this.credentials = account.credentials;
    if (account.credentials.token) {
      this.auth_token = account.credentials.token;
    } else this.auth_token = false;
    this.isLoggedIn = false;
  }

  async login(forceLogin = false) {
    let self = this;
    let sessionActive = await self.checkSession();
    if (sessionActive) {
      return new Promise(async (resolve, reject) => {
        resolve(true);
      })
    } else {
      // console.log(self.credentials.user_id + ' logging in');
      return new Promise((resolve, reject) => {
        var req_options = {
          'method': 'POST',
          'url': self.baseUrl + '/api/v1/user/login',
          'headers': {
            'x-device-type': 'web',
            'Content-Type': 'application/json;charset=UTF-8'
          },
          body: {
            "login_id": self.credentials.user_id,
            "password": self.credentials.password,
            "device": "WEB"
          },
          json: true
        };
        request(req_options, function (error, response, body) {
          if (error) throw new Error(error);
          // console.log(body);
          if (body.data && body.status == 'success' && body.data.twofa && body.data.alert == '2fa pin') {

            req_options = {
              'method': 'POST',
              'url': self.baseUrl + '/api/v1/user/twofa',
              'headers': {
                'x-device-type': 'web',
                'Content-Type': 'application/json;charset=UTF-8'
              },
              body: {
                "login_id": self.credentials.user_id,
                "twofa": [{
                  "answer": self.credentials.twofa,
                  "question_id": body.data.twofa.questions[0].question_id
                }],
                "twofa_token": body.data.twofa.twofa_token,
                "type": body.data.twofa.type
              },
              json: true
            };

            request(req_options, function (error, response, body) {
              if (error) reject(error);
              // console.log(body);
              if (body.status && body.message == 'correct answers' && body.status == 'success') {
                self.setToken(body.data.auth_token)
                self.isLoggedIn = true;
                console.log(self.credentials.user_id + ' logged in');
                resolve(true);
              } else {
                console.log(self.credentials.user_id + ' login error', body);
                resolve(false);
              }
            });
          } else {
            console.log(self.credentials.user_id + ' login error', body);
            resolve(false);
          }
        });
      });
    }
  }

  async setToken(token) {
    this.auth_token = token;
  }

  async checkSession() {
    let self = this;
    try {
      if (self.auth_token) {
        let profile = await self.getProfile();
        if (profile) return true;
        else return false;
      } else return false;
    } catch (err) {
      return false;
    }
  }

  async getProfile() {
    let self = this;
    return new Promise((resolve, reject) => {
      var req_options = {
        'method': 'GET',
        'url': self.baseUrl + '/api/v1/user/profile?client_id=' + self.credentials.user_id,
        'headers': {
          'x-authorization-token': self.auth_token
        },
        json: true
      };
      if (self.auth_token) {
        request(req_options, function (error, response) {
          try {
            if (response.body.status == 'success') {
              resolve(response.body.data);
            } else {
              resolve(response.body);
            }
          } catch (err) {
            resolve(false);
          }
        });
      } else resolve(false);
    });
  }

  async getOrders(type = 'completed') {
    let self = this;
    return new Promise((resolve, reject) => {
      var req_options = {
        'method': 'GET',
        'url': self.baseUrl + '/api/v1/orders?type=' + type + '&client_id=' + self.credentials.user_id,
        'headers': {
          'x-authorization-token': self.auth_token
        },
        json: true
      };
      if (self.auth_token) {
        request(req_options, function (error, response) {
          try {
            resolve(response.body.data.orders);
          } catch (err) {
            resolve(false);
          }
        });
      } else resolve(false);
    });
  }

  async getPositions(pos = 'live') {
    let self = this;
    return new Promise((resolve, reject) => {
      var req_options = {
        'method': 'GET',
        'url': self.baseUrl + '/api/v1/positions?type=' + pos + '&client_id=' + self.credentials.user_id,
        'headers': {
          'x-authorization-token': self.auth_token
        },
        json: true
      };
      if (self.auth_token) {
        request(req_options, function (error, response) {
          try {
            resolve(response.body.data);
          } catch (err) {
            resolve(false);
          }
        });
      } else resolve(false);
    });
  }

  async getBalance() {
    let self = this;
    return new Promise((resolve, reject) => {
      var req_options = {
        'method': 'GET',
        'url': self.baseUrl + '/api/v2/funds/view?type=all&client_id=' + self.credentials.user_id,
        'headers': {
          'x-authorization-token': self.auth_token
        },
        json: true
      };
      request(req_options, function (error, response) {
        if (error) throw new Error(error);
        if (response.body.status == 'success') {
          resolve(response.body.data);
        } else {
          reject(response.body);
        }
      });
    });
  }

  randomString() {
    for (var e = "", t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", a = 0; a < 32; a++)
      e += t.charAt(Math.floor(Math.random() * t.length));
    return e
  }

  /**
   * @description bracket order execute in zerodha
   * @param {Object} options 
   * @param {String} options.exchange_token Exchange Token
   * @param {Number} options.quantity Quantity
   * @param {Number} options.order_side BUY/SELL
   * @param {String} options.order_type LIMIT, MARKET, SL, SLM
   * @param {Number} options.price Price is Limit order type
   * @param {Number} options.trigger_price Price is SLM order type
   * @param {Number} options.product CNC/NRML/MIS
   * @returns {Object} response
   */
  async Order(options) {
    let self = this;
    // console.log(options, type);
    return new Promise((resolve, reject) => {

      var req_options = {
        'method': 'POST',
        'url': self.baseUrl + '/api/v1/orders',
        'headers': {
          'x-authorization-token': self.auth_token,
          'x-device-type': 'web',
          'Content-Type': 'application/json'
        },
        body: Object.assign({
          "exchange": "NFO",
          "instrument_token": options.exchange_token,
          "client_id": self.credentials.user_id,
          "order_type": options.order_type || 'MARKET',
          "disclosed_quantity": 0,
          "validity": "DAY",
          "product": "NRML",
          "device": "WEB",
          "user_order_id": 10002,
          "trigger_price": options.trigger_price || 0,
          "price": options.price || 0,
          "order_tag": "Algo",
          "execution_type": "REGULAR"
        }, options),
        json: true,
        keepAlive: true
      };

      request(req_options, function (error, response, body) {
        if (!error && response.statusCode == 200) {
          resolve({
            status: true,
            resp: body
          });
        } else resolve({
          status: false,
          error: body
        });
      });
    })
  }
  getToken() {
    return this.auth_token;
  }
};

module.exports = Tradelab;
