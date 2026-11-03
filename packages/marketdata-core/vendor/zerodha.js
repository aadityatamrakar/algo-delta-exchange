const debug = require('debug')('trader:zerodha');
const request = require("request");
const qs = require('querystring');
const fs = require('fs');
const FileCookieStore = require('tough-cookie-filestore');
const authenticator = require('authenticator');

class Zerodha {

  constructor(account) {
    this.kite = {
      version: '2.8.0'
    };
    this.req_ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36';
    if (typeof account == 'object') this.loadConfig(account);
    else {
      this.cookie_jar = request.jar(new FileCookieStore(__dirname + '/../userdata/common.json'));
    }
  }

  loadConfig(account) {
    this.credentials = account.credentials;
    this.config = account.config;
    this.lastLogin = account.lastLogin;
    if (!fs.existsSync(__dirname + '/../userdata/' + this.credentials.user_id + '.json')) {
      fs.writeFileSync(__dirname + '/../userdata/' + this.credentials.user_id + '.json', '{}');
    }
    this.loadCookie();
  }

  loadCookie() {
    try {
      this.cookie_jar = request.jar(new FileCookieStore(__dirname + '/../userdata/' + this.credentials.user_id + '.json'));
    } catch (err) {
      fs.writeFileSync(__dirname + '/../userdata/' + this.credentials.user_id + '.json', '{}');
      this.cookie_jar = request.jar(new FileCookieStore(__dirname + '/../userdata/' + this.credentials.user_id + '.json'));
    }
  }

  async login(forceLogin = false) {
    let self = this;
    this.loadCookie();
    let sessionActive = await self.checkSession();
    if (!forceLogin && sessionActive) {
      // console.log('old logging in');
      return new Promise(async (resolve, reject) => {
        resolve(self.config);
      })
    } else {
      console.log(self.credentials.user_id + ' logging in');
      return new Promise((resolve, reject) => {
        let headers = {
          authority: 'kite.zerodha.com',
          referer: 'https://kite.zerodha.com/',
          'content-type': 'application/x-www-form-urlencoded',
          'x-kite-version': this.kite.version,
          'user-agent': this.req_ua,
          origin: 'https://kite.zerodha.com'
        };

        let options = {
          method: 'GET',
          url: 'https://kite.zerodha.com/',
          headers: headers,
          jar: self.cookie_jar
        };

        request(options, function (error, response, body) {
          if (error) throw new Error(error);
          // debug(response.headers["set-cookie"])
          let options = {
            method: 'POST',
            url: 'https://kite.zerodha.com/api/login',
            headers: headers,
            form: {
              user_id: self.credentials.user_id,
              password: self.credentials.password
            },
            json: true,
            gzip: true,
            jar: self.cookie_jar
          };

          request(options, function (error, response, body) {
            if (error) reject(error);
            // debug(response.headers["set-cookie"])
            if (self.credentials.authkey) {
              var formattedKey = authenticator.generateToken(String(self.credentials.authkey).toLowerCase());
              // console.log(`Token: ${formattedKey}`);
              self.credentials.answer = formattedKey;
              if (body.data && body.data.request_id) {
                options.url = 'https://kite.zerodha.com/api/twofa'
                options.body = qs.stringify({
                  user_id: self.credentials.user_id,
                  request_id: body.data.request_id,
                  twofa_value: self.credentials.answer,
                  twofa_type: 'totp',
                  skip_session: ''
                });
                delete options.form;

                request(options, function (error, response, body) {
                  if (error) reject(error);
                  if (body.status && body.status == 'success') {
                    self.config = body;
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
            } else {
              resolve(false);
            }
          });
        });
      });
    }
  }

  async getConfig() {
    let self = this;
    return new Promise((resolve, reject) => {
      var options = {
        method: 'GET',
        url: 'https://kite.zerodha.com/oms/user/profile/full',
        headers: {
          'user-agent': self.req_ua,
          'authorization': 'enctoken ' + self.getAuthorization()
        },
        gzip: true,
        jar: self.cookie_jar,
        json: true
      };
      request(options, function (error, response, body) {
        if (error) reject(error);
        else resolve(body);
      });
    });
  }

  historyData(instrument, type = 'minute', from, to) {
    let self = this;
    return new Promise((resolve, reject) => {

      if (typeof instrument == 'undefined') throw new Error('undefined instrument');

      if (typeof to == 'undefined') to = (new Date()).toISOString().substr(0, 10);
      if (typeof from == 'undefined') {
        from = new Date();
        from.setDate(from.getDate() - 5);
        from = from.toISOString().substr(0, 10);
      }

      let options = {
        method: 'GET',
        url: 'https://kite.zerodha.com/oms/instruments/historical/' + instrument + '/' + type,
        qs: {
          user_id: "XVXVXV",
          from: from,
          to: to,
          oi: 1,
          ciqrandom: (new Date()).getTime()
        },
        headers: {
          'user-agent': self.req_ua,
          'authorization': 'enctoken ' + self.getAuthorization(),
          'referer': 'https://kite.zerodha.com/static/build/chart.html?v=2.4.0'
        },
        json: true
      };

      request(options, function (error, response, body) {
        if (error) reject(error);
        debug(body);
        if (typeof body == 'undefined' || typeof body.data == 'undefined' || body.data == null) {
          reject(body);
        } else {
          let candles = [];
          if (body.data.candles.length > 0 && body.data.candles[0].length == 7) {
            candles = body.data.candles.map(c => {
              return {
                ts: c[0],
                open: c[1],
                high: c[2],
                low: c[3],
                close: c[4],
                vol: c[5],
                oi: c[6]
              };
            });
          } else {
            candles = body.data.candles.map(c => {
              return {
                ts: c[0],
                open: c[1],
                high: c[2],
                low: c[3],
                close: c[4],
                vol: c[5]
              };
            });
          }
          debug(candles.length)
          resolve(candles);
        }
      });
    })
  }

  randomString() {
    for (var e = "", t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", a = 0; a < 32; a++)
      e += t.charAt(Math.floor(Math.random() * t.length));
    return e
  }

  /**
   * @description bracket order execute in zerodha
   * @param {Object} options 
   * @param {String} options.symbol HCLTECH
   * @param {Number} options.price 
   * @param {String} options.type BUY/SELL
   * @param {Number} options.target
   * @param {Number} options.stoploss
   * @param {Number} options.trail_sl
   * @returns {Object} response
   */
  async order(options) {
    let self = this;
    return new Promise((resolve, reject) => {
      var req_options = {
        method: 'POST',
        url: 'https://kite.zerodha.com/oms/orders/bo',
        jar: self.cookie_jar,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-kite-version': self.kite.version,
          'x-kite-userid': self.credentials.user_id,
          'user-agent': self.req_ua,
          'Authorization': 'enctoken ' + self.getAuthorization()
        },
        form: {
          exchange: options.exchange || 'NSE',
          tradingsymbol: options.tradingsymbol, // Symbol
          transaction_type: options.transaction_type, // BUY / SELL
          order_type: 'SL',
          quantity: options.quantity,
          price: options.price, // strike price
          product: 'MIS',
          validity: 'DAY',
          disclosed_quantity: '0',
          trigger_price: options.trigger_price,
          squareoff: options.squareoff, // target
          stoploss: options.stoploss, // stoploss
          trailing_stoploss: options.trailing_stoploss, // trail stoploss
          variety: 'bo',
          user_id: self.credentials.user_id
        },
        json: true
      };

      // console.log(req_options);

      request(req_options, function (error, response, body) {
        if (error) reject(error);
        resolve(body);
      });
    })
  }

  /**
   * @description CNC order execute in zerodha
   * @param {Object} options 
   * @param {String} options.symbol HCLTECH
   * @param {Number} options.price 
   * @param {String} options.type BUY/SELL
   * @param {Number} options.target
   * @param {Number} options.stoploss
   * @param {Number} options.trail_sl
   * @returns {Object} response
   */
  async orderCNC(options, type = 'regular') {
    let self = this;
    // console.log(options, type);
    return new Promise((resolve, reject) => {
      var req_options = {
        method: 'POST',
        url: 'https://kite.zerodha.com/oms/orders/' + type,
        headers: {
          'x-kite-version': self.kite.version,
          'x-kite-userid': self.credentials.user_id,
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': self.req_ua,
          'Authorization': 'enctoken ' + self.getAuthorization(),
        },
        jar: self.cookie_jar,
        json: true,
        form: {
          exchange: options.exchange || 'NSE',
          tradingsymbol: options.symbol,
          transaction_type: options.type,
          order_type: options.order_type,
          quantity: String(options.quantity),
          price: options.price || 0,
          product: 'CNC',
          validity: 'DAY',
          disclosed_quantity: '0',
          trigger_price: type == 'co' ? String(options.trigger_price) : '0',
          squareoff: '0',
          stoploss: '0',
          trailing_stoploss: '0',
          variety: 'regular',
          tag: 'AlgoEQ',
          user_id: self.credentials.user_id
        }
      };

      // console.log(req_options);
      request(req_options, function (error, response, body) {
        console.log(body);
        if (!error && response.statusCode == 200) {
          resolve({
            status: true,
            resp: body
          });
        } else {
          resolve({
            status: false,
            error: body
          });
        }
      });
    })
  }

  /**
   * @description bracket order execute in zerodha
   * @param {Object} options 
   * @param {String} options.tradingsymbol HCLTECH
   * @param {String} options.transaction_type BUY/SELL
   * @param {Number} options.quantity 
   * @param {Number} options.price 0 - for Market order 
   * @param {Number} options.trigger_price
   * @returns {Object} response
   */
  async coverOrder(options) {
    let self = this;
    return new Promise((resolve, reject) => {
      var req_options = {
        method: 'POST',
        url: 'https://kite.zerodha.com/oms/orders/co',
        jar: self.cookie_jar,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-kite-version': self.kite.version,
          'x-kite-userid': self.credentials.user_id,
          'user-agent': self.req_ua,
          'Authorization': 'enctoken ' + self.getAuthorization(),
        },
        form: {
          exchange: options.exchange || 'NSE',
          tradingsymbol: options.tradingsymbol, // Symbol
          transaction_type: options.transaction_type, // BUY / SELL
          order_type: options.price == 0 ? 'MARKET' : 'LIMIT',
          quantity: options.quantity,
          price: options.price, // limit price
          product: 'MIS',
          validity: 'DAY',
          disclosed_quantity: '0',
          trigger_price: options.trigger_price,
          squareoff: '0', // target
          stoploss: '0', // stoploss
          trailing_stoploss: '0', // trail stoploss
          variety: 'co',
          tag: 'ORB',
          user_id: self.credentials.user_id
        },
        json: true
      };

      request(req_options, function (error, response, body) {
        if (error) resolve(error);
        else resolve(body);
      });
    })
  }


  async exitBO_Order(orderId, parent_order_id) {
    let self = this;
    return new Promise((resolve, reject) => {
      var headers = {
        'x-kite-version': self.kite.version,
        'user-agent': self.req_ua,
        'Authorization': 'enctoken ' + self.getAuthorization(),
      };

      var options = {
        url: 'https://kite.zerodha.com/oms/orders/bo/' + orderId + '?order_id=' + orderId + '&parent_order_id=' + parent_order_id + '&variety=bo',
        method: 'DELETE',
        headers: headers,
        jar: self.cookie_jar,
      };

      function callback(error, response, body) {
        if (!error && response.statusCode == 200) {
          resolve({
            status: true
          });
        } else resolve({
          status: false,
          error: body
        })
      }

      request(options, callback);
    });
  }

  async modifyBO_Order(order, trigger_price) {
    let self = this;
    return new Promise((resolve, reject) => {
      var headers = {
        'content-type': 'application/x-www-form-urlencoded',
        'x-kite-version': self.kite.version,
        'x-kite-userid': self.credentials.user_id,
        'user-agent': self.req_ua,
        'Authorization': 'enctoken ' + self.getAuthorization(),
      };

      var options = {
        url: 'https://kite.zerodha.com/oms/orders/bo/' + order.order_id,
        method: 'PUT',
        headers: headers,
        jar: self.cookie_jar,
        form: {
          exchange: order.exchange,
          tradingsymbol: order.tradingsymbol,
          transaction_type: order.transaction_type,
          order_type: order.order_type,
          quantity: order.quantity,
          price: order.price,
          product: 'MIS',
          validity: order.validity,
          disclosed_quantity: '0',
          trigger_price: trigger_price,
          squareoff: '0',
          stoploss: '0',
          trailing_stoploss: '0',
          variety: order.variety,
          user_id: order.placed_by,
          order_id: order.order_id,
          parent_order_id: '',
        }
      };

      function callback(error, response, body) {
        if (!error && response.statusCode == 200) {
          resolve({
            status: true
          });
        } else resolve({
          status: false,
          error: body
        });
      }

      request(options, callback);
    });
  }
  /**
   * @description bracket order execute in zerodha
   * @param {Object} options 
   * @param {String} options.symbol HCLTECH
   * @param {Number} options.price 
   * @param {String} options.type BUY/SELL
   * @param {Number} options.target
   * @param {Number} options.stoploss
   * @param {Number} options.trail_sl
   * @returns {Object} response
   */
  async orderRegular(options, type = 'regular') {
    let self = this;
    // console.log(options, type);
    return new Promise((resolve, reject) => {
      var req_options = {
        method: 'POST',
        url: 'https://kite.zerodha.com/oms/orders/' + type,
        headers: {
          'x-kite-version': self.kite.version,
          'x-kite-userid': self.credentials.user_id,
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': self.req_ua,
          'Authorization': 'enctoken ' + self.getAuthorization(),
        },
        jar: self.cookie_jar,
        json: true,
        form: {
          exchange: 'NSE',
          tradingsymbol: options.symbol,
          transaction_type: options.type,
          order_type: options.order_type,
          quantity: String(options.quantity),
          price: String(options.price),
          product: 'MIS',
          validity: 'DAY',
          disclosed_quantity: '0',
          trigger_price: type == 'co' ? String(options.trigger_price) : '0',
          squareoff: '0',
          stoploss: '0',
          trailing_stoploss: '0',
          variety: 'regular',
          user_id: self.credentials.user_id
        }
      };

      // console.log(req_options);
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

  async orderFNO(options) {
    let self = this;
    // console.log(options, type);
    return new Promise((resolve, reject) => {
      var req_options = {
        method: 'POST',
        url: 'https://kite.zerodha.com/oms/orders/regular',
        headers: {
          'x-kite-version': self.kite.version,
          'x-kite-userid': self.credentials.user_id,
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': self.req_ua,
          'Authorization': 'enctoken ' + self.getAuthorization(),
        },
        jar: self.cookie_jar,
        json: true,
        form: {
          exchange: 'NFO',
          tradingsymbol: options.tradingsymbol,
          transaction_type: options.transaction_type, // BUY / SELL
          order_type: options.order_type, // SL-M, MARKET
          quantity: options.quantity,
          price: options.price,
          product: 'MIS',
          validity: 'DAY',
          disclosed_quantity: '0',
          trigger_price: options.trigger_price || '0',
          squareoff: '0',
          stoploss: '0',
          trailing_stoploss: '0',
          variety: 'regular',
          user_id: self.credentials.user_id
        }
      };

      if (options.tag) req_options.form.tag = options.tag;
      request(req_options, function (error, response, body) {
        if (body) resolve(body);
        else resolve(false);
      });
    })
  }

  async orderFNONrml(options) {
    let self = this;
    // console.log(options, type);
    return new Promise((resolve, reject) => {
      var req_options = {
        method: 'POST',
        url: 'https://kite.zerodha.com/oms/orders/regular',
        headers: {
          'x-kite-version': self.kite.version,
          'x-kite-userid': self.credentials.user_id,
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': self.req_ua,
          'Authorization': 'enctoken ' + self.getAuthorization(),
        },
        jar: self.cookie_jar,
        json: true,
        form: {
          exchange: 'NFO',
          tradingsymbol: options.tradingsymbol,
          transaction_type: options.transaction_type, // BUY / SELL
          order_type: options.order_type, // SL-M, MARKET
          quantity: options.quantity,
          price: options.price,
          product: 'NRML',
          validity: 'DAY',
          disclosed_quantity: '0',
          trigger_price: options.trigger_price || '0',
          squareoff: '0',
          stoploss: '0',
          trailing_stoploss: '0',
          variety: 'regular',
          user_id: self.credentials.user_id
        }
      };

      if (options.tag) req_options.form.tag = options.tag;
      request(req_options, function (error, response, body) {
        if (body) resolve(body);
        else resolve(false);
      });
    })
  }

  async exitRegularOrder(order_id) {
    let self = this;
    return new Promise((resolve, reject) => {
      var options = {
        'method': 'DELETE',
        'url': 'https://kite.zerodha.com/oms/orders/regular/' + order_id,
        'headers': {
          'Authorization': 'enctoken ' + self.getAuthorization(),
        }
      };
      request(options, function (error, response) {
        if (error) resolve(false);
        resolve(response.body);
      });
    });
  }

  async exitCoverOrder(order_id, parent_order_id) {
    let self = this;
    return new Promise((resolve, reject) => {
      var options = {
        'method': 'DELETE',
        'url': 'https://kite.zerodha.com/oms/orders/co/' + order_id + '?parent_order_id=' + parent_order_id,
        'headers': {
          'Authorization': 'enctoken ' + self.getAuthorization(),
        }
      };
      request(options, function (error, response) {
        if (error) resolve(false);
        resolve(response.body);
      });
    });
  }

  async modifyRegularOrder(order_id, price, trigger_price) {
    let self = this;
    return new Promise((resolve, reject) => {
      var options = {
        'method': 'PUT',
        'url': 'https://kite.zerodha.com/oms/orders/regular/' + order_id,
        'headers': {
          'Authorization': 'enctoken ' + self.getAuthorization(),
        },
        form: {
          'order_id': order_id,
          'price': price,
          'trigger_price': trigger_price
        },
        json: true
      };
      request(options, function (error, response) {
        if (error) resolve(false);
        resolve(response.body);
      });
    });
  }

  async modifyCoverSL(order_id, parent_order_id, trigger_price) {
    let self = this;
    return new Promise((resolve, reject) => {
      var options = {
        'method': 'PUT',
        'url': 'https://kite.zerodha.com/oms/orders/co/' + order_id + '?parent_order_id=' + parent_order_id,
        'headers': {
          'Authorization': 'enctoken ' + self.getAuthorization(),
        },
        form: {
          'order_id': order_id,
          'price': 0,
          'trigger_price': trigger_price
        },
        json: true
      };
      request(options, function (error, response) {
        if (error) resolve(false);
        resolve(response.body);
      });
    });
  }

  async fnoStrategyMargin(options) {
    let self = this;
    // console.log(options, type);
    return new Promise((resolve, reject) => {
      var req_options = {
        method: 'POST',
        url: 'https://kite.zerodha.com/oms/margins/basket?mode=compact',
        headers: {
          'x-kite-version': self.kite.version,
          'x-kite-userid': self.credentials.user_id,
          'content-type': 'application/json',
          'user-agent': self.req_ua,
          'Authorization': 'enctoken ' + self.getAuthorization(),
        },
        jar: self.cookie_jar,
        json: true,
        body: []
      };

      req_options.body = options.map(order => {
        return {
          exchange: 'NFO',
          tradingsymbol: order.tradingsymbol,
          transaction_type: order.transaction_type, // BUY / SELL
          order_type: order.order_type, // SL-M, MARKET
          quantity: order.quantity,
          price: order.price,
          product: 'MIS',
          trigger_price: order.trigger_price || 0,
          squareoff: 0,
          stoploss: 0,
          variety: 'regular',
        };
      });

      request(req_options, function (error, response, body) {
        if (!error && response.statusCode == 200) {
          resolve(body.data);
        } else resolve(false);
      });
    })
  }

  async getQoute(instrument) {
    let self = this;
    return new Promise((resolve, reject) => {
      var options = {
        method: 'GET',
        url: 'https://api.kite.trade/quote',
        qs: {
          i: instrument
        },
        headers: {
          Connection: 'keep-alive',
          'Authorization': 'enctoken ' + self.getAuthorization(),
          'X-Kite-Version': '3'
        },
        gzip: true,
        json: true
      };

      request(options, function (error, response, body) {
        if (error) reject(error);
        try {
          body = body.data[instrument];
          resolve(body);
        } catch (err) {
          reject(err);
          console.log(err);
        }
      });
    });
  }

  async getMultiOHLC(instruments) {
    let self = this;
    return new Promise((resolve, reject) => {
      var options = {
        method: 'GET',
        url: 'https://api.kite.trade/quote',
        headers: {
          Connection: 'keep-alive',
          'Authorization': 'enctoken ' + self.getAuthorization(),
          'X-Kite-Version': '3'
        },
        gzip: true,
        json: true
      };

      if (instruments.length > 0) {
        options.url += '?i=' + instruments.join('&i=');
        // console.log(options);
        request(options, function (error, response, body) {
          // console.log(body);
          if (error) resolve(false);
          else if (body.status == 'success') resolve(body.data);
          else resolve(false);
        });
      } else resolve(false);
    });
  }

  async orders() {
    let self = this;
    return new Promise((resolve, reject) => {
      var options = {
        method: 'GET',
        url: 'https://kite.zerodha.com/oms/orders',
        headers: {
          Connection: 'keep-alive',
          'Authorization': 'enctoken ' + self.getAuthorization(),
          'X-Kite-Version': '3'
        },
        gzip: true,
        json: true
      };

      request(options, function (error, response, body) {
        if (error) reject(error);
        try {
          body = body.data;

          // body.forEach(p => {
          //   p.quantity = p.quantity * 10;
          //   p.status_message = '';
          // });

          resolve(body);
        } catch (err) {
          reject(err);
          console.log(err);
        }
      });
    });
  }

  async margins() {
    let self = this;
    return new Promise((resolve, reject) => {
      var options = {
        method: 'GET',
        url: 'https://kite.zerodha.com/oms/user/margins',
        headers: {
          Connection: 'keep-alive',
          'Authorization': 'enctoken ' + self.getAuthorization(),
          'X-Kite-Version': self.kite.version
        },
        gzip: true,
        json: true
      };

      request(options, function (error, response, body) {
        if (!error && body) {
          resolve(body.data)
        } else resolve(false);
      });
    });
  }

  async positions() {
    let self = this;
    return new Promise((resolve, reject) => {
      var options = {
        method: 'GET',
        url: 'https://kite.zerodha.com/oms/portfolio/positions',
        headers: {
          Connection: 'keep-alive',
          'Authorization': 'enctoken ' + self.getAuthorization(),
          'X-Kite-Version': self.kite.version
        },
        gzip: true,
        json: true
      };

      request(options, function (error, response, body) {
        if (error) reject(error);
        try {
          body = body.data;

          // body.net.forEach(p => {
          //   p.m2m = p.m2m * 10;
          // });

          resolve(body);
        } catch (err) {
          reject(err);
          console.log(err);
        }
      });
    });
  }

  async checkHost() {
    let self = this;
    return new Promise((resolve, reject) => {
      var options = {
        method: 'GET',
        url: 'https://kite.zerodha.com/dashboard',
        headers: {
          Connection: 'keep-alive'
        },
        gzip: true
      };

      request(options, function (error, response, body) {
        if (error) reject(error);
        try {
          resolve(true);
        } catch (err) {
          reject(err);
          console.log(err);
        }
      });
    });
  }

  async checkSession() {
    let self = this;
    return new Promise((resolve, reject) => {
      var options = {
        method: 'GET',
        url: 'https://kite.zerodha.com/oms/user/profile/full',
        headers: {
          Connection: 'keep-alive',
          'Authorization': 'enctoken ' + self.getAuthorization(),
        },
        jar: self.cookie_jar,
        gzip: true,
        json: true
      };

      request(options, function (error, response, body) {
        if (error) reject(error);
        try {
          if (body.status == 'error') {
            resolve(false);
          } else resolve(true);
        } catch (err) {
          console.log(err);
          resolve(false);
        }
      });
    });
  }

  getAuthorization() {
    let self = this;
    try {
      return self.cookie_jar._jar.store.idx['kite.zerodha.com']['/']['enctoken'].value;
    } catch (e) {
      // console.log('token not found', e);
      return false;
    }
  }
  getPublicToken() {
    let self = this;
    try {
      return self.cookie_jar._jar.store.idx['zerodha.com']['/']['public_token'].value;
    } catch (e) {
      console.log('token not found', self.credentials.user_id);
      return false;
    }
  }

  intradayBrokerageCalc(buy_price, sell_price, qty) {
    let bp = buy_price;
    let sp = sell_price;
    let bplan = 0.0003;
    var brokerage_buy = ((bp * qty * bplan) > 20) ? 20 : parseFloat(parseFloat(bp * qty * bplan).toFixed(2));
    var brokerage_sell = ((sp * qty * bplan) > 20) ? 20 : parseFloat(parseFloat(sp * qty * bplan).toFixed(2));
    var brokerage = parseFloat(parseFloat(brokerage_buy + brokerage_sell).toFixed(2));
    var turnover = parseFloat(parseFloat((bp + sp) * qty).toFixed(2));
    var stt_total = Math.round(parseFloat(parseFloat((sp * qty) * 0.00025).toFixed(2)));
    var exc_trans_charge = parseFloat(parseFloat(0.0000325 * turnover).toFixed(2));
    var cc = 0;
    var stax = parseFloat(parseFloat(0.18 * (brokerage + exc_trans_charge)).toFixed(2));
    var sebi_charges = parseFloat(parseFloat(turnover * 0.000001).toFixed(2));
    var total_tax = parseFloat(parseFloat(brokerage + stt_total + exc_trans_charge + cc + stax + sebi_charges).toFixed(2));
    var breakeven = parseFloat(parseFloat(total_tax / qty).toFixed(2));
    breakeven = isNaN(breakeven) ? 0 : breakeven
    var net_profit = parseFloat(parseFloat(((sp - bp) * qty) - total_tax).toFixed(2));

    return {
      turnover,
      brokerage,
      stt_total,
      exc_trans_charge,
      cc,
      stax,
      sebi_charges,
      total_tax,
      breakeven,
      net_profit,
    }
  }
};

module.exports = Zerodha;
