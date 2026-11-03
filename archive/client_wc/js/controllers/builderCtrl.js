angular
  .module("app")
  .controller("ParityController", function ($scope, $timeout, $rootScope, PaperTrade, ParityFeed, $stateParams) {
    $scope.spreads = {};
    $scope.dollarRate = 79;
    $scope.ce_filter = {
      mcx: {
        instrument_type: "CE"
      }
    };
    $scope.pe_filter = {
      mcx: {
        instrument_type: "PE"
      }
    };
    $scope.spreads_tbl = [];
    $scope.onData = function (data) {
      $scope.spreads[data.nymex.localSymbol] = data;
      $scope.spreads_tbl = Object.values($scope.spreads);
    }
    ParityFeed.on('ticks', $scope.onData);
    ParityFeed.on('dollar_rate', $scope.updateRate);
    $scope.updateRate = function (data) {
      $scope.dollarRate = data.rate;
      $scope.$apply();
    }
    $scope.sendDollarRate = function () {
      ParityFeed.emit('dollar_rate', $scope.dollarRate);
      $scope.spreads = {};
      $scope.spreads_tbl = [];
    }

  })
  .controller("SpreadsController", function ($scope, $timeout, $rootScope, PaperTrade, ChangeStream, $stateParams) {
    $scope.limitStrikes = 15;
    $scope.subscribeOpts = [];
    $scope.subscribedOpts = [];
    $scope.currentDomain = 'http://3.6.199.136';

    $scope.connectSocket = function () {
      // if ($scope.socket.connected()) {
      //   // console.log('Subscribing');
      //   $scope.subscribeOpts = Array.from(new Set($scope.subscribeOpts));
      //   $scope.subscribeOpts = $scope.subscribeOpts.filter(function (token) {
      //     return $scope.subscribedOpts.indexOf(token) == -1;
      //   });
      //   let allTokens = $scope.subscribeOpts;
      //   $scope.subscribedOpts.push(...allTokens);
      //   // console.log('subs:' + allTokens.length);
      //   $scope.socket.subscribe(allTokens);
      //   $scope.socket.setMode('full', allTokens);
      //   $rootScope.ticker.on("ticks", $scope.onTicks);
      // } else {
      //   $scope.socket = ticker.fn();
      //   // console.log('not connected');
      //   $timeout($scope.connectSocket, 1000);
      // }
      ChangeStream.emit('get_ticks');
    }

    $scope.ticksCache = {};
    $scope.onTicks = function (ticks) {
      Object.assign($scope.ticksCache, ticks);
      if ($scope.spreads.length > 0 || $scope.user_spreads.length > 0) {
        $scope.calcSpreads();
      }
      // $scope.$apply();
    }
    ChangeStream.on('ticks', $scope.onTicks);

    // Cleanup event listeners when controller is destroyed
    $scope.$on('$destroy', function() {
      ChangeStream.off('ticks', $scope.onTicks);
    });

    $scope.instruments = [];
    $scope.getInstruments = function () {
      fetch($scope.currentDomain + '/options/instruments')
        .then(function (resp) {
          return resp.json();
        })
        .then(function (resp) {
          $scope.instruments = resp.data;
        });
    }
    $scope.getInstruments();

    let roundOff = function (n) {
      return Math.round(n * 10) / 10;
    }
    $scope.getLivePrices = function (symbol) {
      let token = $scope.instruments[symbol].instrument_token;
      fetch($scope.currentDomain + '/options/live_prices/' + token)
        .then(function (resp) {
          return resp.json();
        })
        .then(function (resp) {
          $scope.livePrices = resp.data;
          let expiry = $scope.expirySelected;
          let options = $scope.livePrices.per_expiry_data[expiry].options;
          for (let i = 0; i < options.length; i++) {
            let row = options[i];
            $scope.subscribeOpts.push(row.token);
            let strike = $scope.optionStrikeByToken[row.token];
            if (row.greeks_with_iv) {
              $scope.optionInstruments[expiry][strike].greeks = {
                delta: roundOff(row.greeks_with_iv.delta * $scope.lot_size),
                gamma: roundOff(row.greeks_with_iv.gamma * $scope.lot_size),
                theta: roundOff(row.greeks_with_iv.theta * $scope.lot_size),
                vega: roundOff(row.greeks_with_iv.vega * $scope.lot_size),
                iv: roundOff(row.greeks_with_iv.iv * 100),
              };

              $scope.optionInstruments[expiry][strike].volume = row.volume;
              $scope.optionInstruments[expiry][strike].oi = row.oi;
              $scope.optionInstruments[expiry][strike].oi_change = row.oi_change;
              $scope.optionInstruments[expiry][strike].last_price = row.last_price;
              $scope.optionInstruments[expiry][strike].ltp_change = row.ltp_change;
              $scope.optionInstruments[expiry][strike].last_trade_time = row.last_trade_time;
            }
          }
          // $scope.socket = ticker.fn();
          $scope.connectSocket();
        });
    }

    $scope.loadingBtn = false;
    $scope.optionStrikeByToken = {};
    $scope.tokenToSymbol = {};
    $scope.lot_size = 0;
    $scope.getInstrumentDetails = function (symbol) {
      $scope.loadingBtn = true;
      fetch($scope.currentDomain + '/options/instrument_strikes/' + symbol)
        .then(function (resp) {
          return resp.json();
        })
        .then(function (resp) {
          $scope.instrument_details = resp.data;
          $scope.optionInstruments = {
            strikes: []
          };
          $scope.expiry_available.forEach(function (expiry) {
            $scope.optionInstruments[expiry] = {};
          });
          $scope.instrument_details.forEach(function (row) {
            if (row.segment == "NFO-OPT") {
              $scope.tokenToSymbol[row.instrument_token] = row.tradingsymbol;
              $scope.optionStrikeByToken[row.instrument_token] = row.strike + row.instrument_type;
              $scope.optionInstruments[row.expiry][row.strike + row.instrument_type] = row;
              $scope.optionInstruments.strikes.push(row.strike);
            }
          });
          $scope.optionInstruments.strikes = Array.from(new Set($scope.optionInstruments.strikes)).sort((a, b) => (a - b));
          let atm_strike = $scope.instruments[$scope.selectedInstrument].per_expiry_data[$scope.expirySelected].strike;
          let atm_strike_index = $scope.optionInstruments.strikes.indexOf(atm_strike);
          let right_index = (atm_strike_index + ($scope.limitStrikes + 1));
          let left_index = atm_strike_index - ($scope.limitStrikes);
          $scope.optionInstruments.strikes.splice(right_index);
          $scope.optionInstruments.strikes.splice(0, left_index);
          $scope.loadingBtn = false;
          $scope.getLivePrices($scope.selectedInstrument);
        });
    }


    $scope.spread_params = function (type) {
      // if (type == 'load') {
      //   if (window.localStorage.getItem($scope.selectedInstrument + '_spread_params')) {
      //     let params = window.localStorage.getItem($scope.selectedInstrument + '_spread_params');
      //     params = JSON.parse(params);
      //     $scope.spreadType = params[0];
      //     $scope.spreadMinRange = params[1];
      //     $scope.spreadMaxRange = params[2];
      //     $scope.strikeMinDistance = params[3];
      //     $scope.strikeMaxDistance = params[4];
      //     $scope.strikeMinGap = params[5];
      //     $scope.strikeMaxGap = params[6];
      //   }
      // }
      // if (type == 'save') {
      //   window.localStorage.setItem($scope.selectedInstrument + '_spread_params', JSON.stringify([$scope.spreadType, $scope.spreadMinRange, $scope.spreadMaxRange, $scope.strikeMinDistance, $scope.strikeMaxDistance, $scope.strikeMinGap, $scope.strikeMaxGap]));
      // }
    }

    $scope.expiry_available = [];
    $scope.updateExpiry = function () {
      let instrument = $scope.instruments[$scope.selectedInstrument];
      $scope.expiry_available = Object.keys(instrument.per_expiry_data);
      $scope.futureInstruments = Object.values(instrument.per_expiry_data);
      $scope.futureInstruments = $scope.futureInstruments.sort(function (a, b) {
        return a.daysToExpiry - b.daysToExpiry;
      });
      if (!$scope.expirySelected) {
        $scope.expirySelected = $scope.futureInstruments[0].expiry;
      }
      $scope.lot_size = $scope.futureInstruments[0].lot_size;
      $scope.getInstrumentDetails($scope.selectedInstrument);
      $scope.spread_params('load');
    }

    $scope.abs = (n) => roundOff(Math.abs(n));

    $scope.user_spreads = [];
    $scope.spreads = [];
    $scope.makeSpreads = function () {
      $scope.spread_params('save');
      // console.log($scope.instruments[$scope.selectedInstrument]);
      let instrument = $scope.instruments[$scope.selectedInstrument];
      let currentATM = Math.round(instrument.last_price / 100) * 100;
      let minDistance = $scope.strikeMinDistance;
      let maxDistance = $scope.strikeMaxDistance;
      let minGap = $scope.strikeMinGap;
      let maxGap = $scope.strikeMaxGap;
      // console.log($scope.expirySelected);
      // console.log($scope.optionInstruments);
      $scope.spreads = [];
      for (i = minDistance; i < maxDistance; i++) {
        let strike_1_ce = currentATM + (i * 100);
        let strike_1_pe = currentATM - (i * 100);
        let token_1_ce = $scope.optionInstruments[$scope.expirySelected][strike_1_ce + 'CE'].instrument_token;
        let token_1_pe = $scope.optionInstruments[$scope.expirySelected][strike_1_pe + 'PE'].instrument_token;
        $scope.subscribeOpts.push(token_1_ce);
        $scope.subscribeOpts.push(token_1_pe);
        for (j = (i + minGap); j < (i + maxGap); j++) {
          if (i == j) continue;
          let strike_2_ce = currentATM + (j * 100);
          let strike_2_pe = currentATM - (j * 100);
          let token_2_ce = $scope.optionInstruments[$scope.expirySelected][strike_2_ce + 'CE'].instrument_token;
          let token_2_pe = $scope.optionInstruments[$scope.expirySelected][strike_2_pe + 'PE'].instrument_token;
          $scope.spreads.push({
            type: "Call",
            strike_1: strike_1_ce,
            strike_2: strike_2_ce,
            token_1: token_1_ce,
            token_2: token_2_ce,
            distance: i,
            gap: j - i
          });
          $scope.spreads.push({
            type: "Put",
            strike_1: strike_1_pe,
            strike_2: strike_2_pe,
            token_1: token_1_pe,
            token_2: token_2_pe,
            distance: i,
            gap: j - i
          });
          $scope.subscribeOpts.push(token_2_ce);
          $scope.subscribeOpts.push(token_2_pe);
        }
      }
      $scope.calcSpreads();
    }

    function _calcSpreads(elm) {
      try {
        elm.bid_1 = $scope.ticksCache[elm['token_1']];
        elm.ask_1 = $scope.ticksCache[elm['token_1']];
        elm.bid_2 = $scope.ticksCache[elm['token_2']];
        elm.ask_2 = $scope.ticksCache[elm['token_2']];

        if ($scope.spreadType == 'Debit') {
          elm.exit = (2 * elm.ask_2) - elm.bid_1;
          elm.entry = elm.ask_1 - (2 * elm.bid_2);
        } else {
          elm.exit = elm.ask_1 - (2 * elm.bid_2);
          elm.entry = (2 * elm.ask_2) - elm.bid_1;
        }
        elm.entry = parseFloat((elm.entry * -1).toFixed(1));
        elm.exit = parseFloat((elm.exit * -1).toFixed(1));
        elm.slippage = roundOff(elm.entry + elm.exit);
        if (elm.entry >= $scope.spreadMinRange && elm.entry <= $scope.spreadMaxRange) {
          elm.visible = true;
        }
      } catch (err) {
        console.log(err);
      }
    }

    $scope.calcSpreads = function () {
      $scope.spreads.forEach(_calcSpreads);
      $scope.user_spreads.forEach(_calcSpreads);
      // console.log($scope.spreads);
    }


    $scope.addWatch = function () {
      let instrument = $scope.instruments[$scope.selectedInstrument];
      let currentATM = Math.round(instrument.last_price / 100) * 100;
      let strikeStep = $scope.optionInstruments.strikes[1] - $scope.optionInstruments.strikes[0];
      let strike_1 = $scope.watchlist.strike_1;
      let strike_2 = $scope.watchlist.strike_2;

      if ($scope.watchlist.type == 'Call') {
        let token_1 = $scope.optionInstruments[$scope.expirySelected][strike_1 + 'CE'].instrument_token;
        let token_2 = $scope.optionInstruments[$scope.expirySelected][strike_2 + 'CE'].instrument_token;

        $scope.user_spreads.push({
          type: "Call",
          strike_1: strike_1,
          strike_2: strike_2,
          token_1: token_1,
          token_2: token_2,
          distance: Math.abs(currentATM - strike_1) / strikeStep,
          gap: Math.abs(strike_2 - strike_1) / strikeStep
        });
      } else {
        let token_1 = $scope.optionInstruments[$scope.expirySelected][strike_1 + 'PE'].instrument_token;
        let token_2 = $scope.optionInstruments[$scope.expirySelected][strike_2 + 'PE'].instrument_token;

        $scope.user_spreads.push({
          type: "Put",
          strike_1: strike_1,
          strike_2: strike_2,
          token_1: token_1,
          token_2: token_2,
          distance: Math.abs(currentATM - strike_1) / strikeStep,
          gap: Math.abs(strike_2 - strike_1) / strikeStep
        });
      }

      $scope.user_spreads.forEach(_calcSpreads);
    }

  })
  .controller("BuilderController", function ($scope, $timeout, $rootScope, PaperTrade, ChangeStream, Account, $stateParams) {
    $scope.limitStrikes = 15;

    $scope.shortCurrency = function (num) {
      var val = Math.abs(num);
      if (val >= 10000000) {
        val = (val / 10000000).toFixed(2) + ' Cr';
      } else if (val >= 100000) {
        val = (val / 100000).toFixed(1) + ' L';
      } else {
        val = (val / 1000).toFixed(0) + ' K';
      }
      return val;
    }

    $scope.instruments = [];
    $scope.getInstruments = function () {
      fetch('/options/instruments')
        .then(function (resp) {
          return resp.json();
        })
        .then(function (resp) {
          $scope.instruments = resp.data;
        });
    }
    $scope.getInstruments();

    let roundOff = function (n) {
      return Math.round(n * 10) / 10;
    }
    $scope.getLivePrices = function (symbol) {
      let token = $scope.instruments[symbol].instrument_token;
      fetch('/options/live_prices/' + token)
        .then(function (resp) {
          return resp.json();
        })
        .then(function (resp) {
          $scope.livePrices = resp.data;
          let expiry = $scope.expirySelected;
          let options = $scope.livePrices.per_expiry_data[expiry].options;
          options.forEach(function (row) {
            let strike = $scope.optionStrikeByToken[row.token];
            if (row.greeks_with_iv) {
              $scope.optionInstruments[expiry][strike].greeks = {
                delta: roundOff(row.greeks_with_iv.delta * $scope.lot_size),
                gamma: roundOff(row.greeks_with_iv.gamma * $scope.lot_size),
                theta: roundOff(row.greeks_with_iv.theta * $scope.lot_size),
                vega: roundOff(row.greeks_with_iv.vega * $scope.lot_size),
                iv: roundOff(row.greeks_with_iv.iv * 100),
              };

              $scope.optionInstruments[expiry][strike].volume = row.volume;
              $scope.optionInstruments[expiry][strike].oi = row.oi;
              $scope.optionInstruments[expiry][strike].oi_change = row.oi_change;
              $scope.optionInstruments[expiry][strike].last_price = row.last_price;
              $scope.optionInstruments[expiry][strike].ltp_change = row.ltp_change;
              $scope.optionInstruments[expiry][strike].last_trade_time = row.last_trade_time;
            }
          })

        });
    }

    $scope.loadingBtn = false;
    $scope.optionStrikeByToken = {};
    $scope.tokenToSymbol = {};
    $scope.lot_size = 0;
    $scope.getInstrumentDetails = function (symbol) {
      $scope.loadingBtn = true;
      fetch('/options/instrument_strikes/' + symbol)
        .then(function (resp) {
          return resp.json();
        })
        .then(function (resp) {
          $scope.instrument_details = resp.data;
          $scope.optionInstruments = {
            strikes: []
          };
          $scope.expiry_available.forEach(function (expiry) {
            $scope.optionInstruments[expiry] = {};
          });
          $scope.instrument_details.forEach(function (row) {
            if (row.segment == "NFO-OPT") {
              $scope.tokenToSymbol[row.instrument_token] = row.tradingsymbol;
              $scope.optionStrikeByToken[row.instrument_token] = row.strike + row.instrument_type;
              $scope.optionInstruments[row.expiry][row.strike + row.instrument_type] = row;
              $scope.optionInstruments.strikes.push(row.strike);
            }
          });
          $scope.optionInstruments.strikes = Array.from(new Set($scope.optionInstruments.strikes)).sort((a, b) => (a - b));
          let atm_strike = $scope.instruments[$scope.selectedInstrument].per_expiry_data[$scope.expirySelected].strike;
          let atm_strike_index = $scope.optionInstruments.strikes.indexOf(atm_strike);
          let right_index = (atm_strike_index + ($scope.limitStrikes + 1));
          let left_index = atm_strike_index - ($scope.limitStrikes);
          $scope.optionInstruments.strikes.splice(right_index);
          $scope.optionInstruments.strikes.splice(0, left_index);
          $scope.loadingBtn = false;
          $scope.getLivePrices($scope.selectedInstrument);
        });
    }

    $scope.expiry_available = [];
    $scope.updateExpiry = function () {
      let instrument = $scope.instruments[$scope.selectedInstrument];
      $scope.expiry_available = Object.keys(instrument.per_expiry_data);
      $scope.futureInstruments = Object.values(instrument.per_expiry_data);
      $scope.futureInstruments = $scope.futureInstruments.sort(function (a, b) {
        return a.daysToExpiry - b.daysToExpiry;
      });
      if (!$scope.expirySelected) {
        $scope.expirySelected = $scope.futureInstruments[0].expiry;
      }
      $scope.lot_size = $scope.futureInstruments[0].lot_size;
      $scope.getInstrumentDetails($scope.selectedInstrument);
      $scope.showFutTbl = true;
      $scope.showOptTbl = true;
      let expiry_ivs = Object.values(instrument.per_expiry_data).reduce((obj, val) => {
        $scope.tokenToSymbol[val.future_instrument_token] = val.future_symbol;
        obj[val.expiry] = val.impliedVolatility;
        return obj;
      }, {});
      let futures_per_expiry = Object.values(instrument.per_expiry_data).reduce((obj, val) => {
        obj[val.expiry] = val.futurePrice;
        return obj;
      }, {});

      $scope.strategy = {
        underlying_token: instrument.instrument_token,
        current_underlying_price: instrument.last_price,
        atm_iv_per_expiry: expiry_ivs,
        target_underlying_price: instrument.last_price,
        target_datetime: new Date($scope.expirySelected + "T10:00:00.000Z"),
        futures_per_expiry: futures_per_expiry,
        trades: []
      }
    }

    function uuidv4() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0,
          v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    }
    $scope.strategy = {};
    $scope.addToTrade = function (instrument, instrument_type, trade_side) {
      let trade = {
        tag: "leg:" + uuidv4(),
        trade_action: trade_side,
        quantity: 1
      };

      if (instrument_type == 'future') {
        trade.instrument_token = instrument.future_instrument_token;
        trade.entry_price = instrument.futurePrice;
        trade.implied_volatility = 0;
        $scope.strategy.trades.push(trade);
      } else if (instrument_type == 'option') {
        trade.instrument_token = instrument.instrument_token;
        trade.entry_price = instrument.last_price;
        trade.implied_volatility = instrument.greeks.iv;
        $scope.strategy.trades.push(trade);
      }
    }

    $scope.updateQty = function (idx) {
      let qty = prompt('Quantity?', $scope.strategy.trades[idx].quantity);
      if (parseInt(qty) > 0) {
        $scope.strategy.trades[idx].quantity = parseInt(qty);
      }
    }
    $scope.updatePrice = function (idx) {
      let price = prompt('Price?', $scope.strategy.trades[idx].entry_price);
      if (parseFloat(price) > 0) {
        $scope.strategy.trades[idx].entry_price = parseFloat(price);
      }
    }

    $scope.removeTrade = function (idx) {
      if (confirm("Sure?")) {
        $scope.strategy.trades.splice(idx, 1);
      }
    }

    $scope.payoff = {};
    $scope.buildBtn = false;
    $scope.builder = function () {
      $scope.buildBtn = true;
      var myHeaders = new Headers();
      myHeaders.append("Content-Type", "application/json");
      var requestOptions = {
        method: 'POST',
        headers: myHeaders,
        body: JSON.stringify($scope.strategy)
      };

      fetch("/options/builder", requestOptions)
        .then(response => response.json())
        .then(resp => {
          $scope.showFutTbl = false;
          $scope.showOptTbl = false;
          $scope.payoff = resp.data;
          $scope.payoff.breakevens_at_expiry = $scope.payoff.breakevens_at_expiry.map(roundOff);
          $scope.drawChart(resp.data);
          $scope.buildBtn = false;
        })
        .catch(error => console.log('error', error));
    }

    $scope.abs = (n) => roundOff(Math.abs(n));
    $scope.drawChart = function (data) {
      let payoff_range = data.payoff_range;
      let labels = [];
      let payoff_target = [];
      let payoff_expiry = [];

      data.payoffs_at_expiry.forEach((row, idx) => {
        if (row.at >= payoff_range.x_min && row.at <= payoff_range.x_max) {
          labels.push(row.at);
          payoff_target.push(roundOff(data.payoffs_at_target[idx].payoff));
          payoff_expiry.push(roundOff(row.payoff))
        }
      });

      let config = {
        type: 'line',
        data: {
          labels: labels,
          datasets: [{
            label: 'Target',
            fill: false,
            data: payoff_target,
            borderColor: 'rgb(201, 203, 207)',
            backgroundColor: 'rgba(201, 203, 207, 0.5)',
          },
          {
            label: 'Expiry',
            fill: false,
            data: payoff_expiry,
            borderColor: 'rgb(54, 162, 235)',
            backgroundColor: 'rgba(54, 162, 235, 0.5)',
          }
          ]
        },
        options: {
          responsive: true,
          interaction: {
            intersect: false,
            mode: 'index',
          },
          plugins: {
            legend: {
              display: false
            }
          }
        },
      };

      document.getElementById('chart-area').innerHTML = '<canvas id="payoffChart" style="width: 100%; height: 100%;"></canvas>';
      var myChart = new Chart(
        document.getElementById('payoffChart'),
        config
      );
    }


    $scope.getStrategies = function () {
      $scope.generator = {
        instrumentSymbol: $scope.selectedInstrument,
        targetDate: $scope.expirySelected + "T15:30:00+05:30",
        includedExpiries: [$scope.expirySelected],
        impliedVolatilityATMOnTargetDatePerExpiry: {
          [$scope.expirySelected]: 0
        },
        marketView: "ABOVE", // ABOVE, BELOW, BETWEEN
        instrumentPriceRange: {},
      };

      var myHeaders = new Headers();
      myHeaders.append("Content-Type", "application/json");
      var requestOptions = {
        method: 'POST',
        headers: myHeaders,
        body: JSON.stringify($scope.generator)
      };

      fetch("/options/builder", requestOptions)
        .then(response => response.json())
        .then(resp => {
          $scope.showFutTbl = false;
          $scope.showOptTbl = false;
          $scope.payoff = resp.data;
          $scope.payoff.breakevens_at_expiry = $scope.payoff.breakevens_at_expiry.map(roundOff);
          $scope.drawChart(resp.data);
          $scope.buildBtn = false;
        })
        .catch(error => console.log('error', error));
    }
  })
  .controller("ComboController", function ($scope, $timeout, $rootScope, PaperTrade, ChangeStream, Spreads, $stateParams) {
    $scope.baseUrl = 'http://3.6.199.136';
    $scope.limitStrikes = 15;

    $scope.shortCurrency = function (num) {
      var val = Math.abs(num);
      if (val >= 10000000) {
        val = (val / 10000000).toFixed(2) + ' Cr';
      } else if (val >= 100000) {
        val = (val / 100000).toFixed(1) + ' L';
      } else {
        val = (val / 1000).toFixed(0) + ' K';
      }
      return val;
    }

    $scope.instruments = [];
    $scope.getInstruments = function () {
      fetch($scope.baseUrl + '/options/instruments')
        .then(function (resp) {
          return resp.json();
        })
        .then(function (resp) {
          $scope.instruments = resp.data;
        });
    }
    $scope.getInstruments();

    let roundOff = function (n) {
      return Math.round(n * 10) / 10;
    }
    $scope.getLivePrices = function (symbol) {
      let token = $scope.instruments[symbol].instrument_token;
      fetch($scope.baseUrl + '/options/live_prices/' + token)
        .then(function (resp) {
          return resp.json();
        })
        .then(function (resp) {
          $scope.livePrices = resp.data;
          let expiry = $scope.expirySelected;
          let options = $scope.livePrices.per_expiry_data[expiry].options;
          options.forEach(function (row) {
            let strike = $scope.optionStrikeByToken[row.token];
            if (row.greeks_with_iv) {
              $scope.optionInstruments[expiry][strike].greeks = {
                delta: roundOff(row.greeks_with_iv.delta * $scope.lot_size),
                gamma: roundOff(row.greeks_with_iv.gamma * $scope.lot_size),
                theta: roundOff(row.greeks_with_iv.theta * $scope.lot_size),
                vega: roundOff(row.greeks_with_iv.vega * $scope.lot_size),
                iv: roundOff(row.greeks_with_iv.iv * 100),
              };

              $scope.optionInstruments[expiry][strike].volume = row.volume;
              $scope.optionInstruments[expiry][strike].oi = row.oi;
              $scope.optionInstruments[expiry][strike].oi_change = row.oi_change;
              $scope.optionInstruments[expiry][strike].last_price = row.last_price;
              $scope.optionInstruments[expiry][strike].ltp_change = row.ltp_change;
              $scope.optionInstruments[expiry][strike].last_trade_time = row.last_trade_time;
            }
          })

        });
    }

    $scope.loadingBtn = false;
    $scope.optionStrikeByToken = {};
    $scope.tokenToSymbol = {};
    $scope.lot_size = 0;
    $scope.getInstrumentDetails = function (symbol) {
      $scope.loadingBtn = true;
      fetch($scope.baseUrl + '/options/instrument_strikes/' + symbol)
        .then(function (resp) {
          return resp.json();
        })
        .then(function (resp) {
          $scope.instrument_details = resp.data;
          $scope.optionInstruments = {
            strikes: []
          };
          $scope.expiry_available.forEach(function (expiry) {
            $scope.optionInstruments[expiry] = {};
          });
          $scope.instrument_details.forEach(function (row) {
            if (row.segment == "NFO-OPT") {
              $scope.tokenToSymbol[row.instrument_token] = row.tradingsymbol;
              $scope.optionStrikeByToken[row.instrument_token] = row.strike + row.instrument_type;
              $scope.optionInstruments[row.expiry][row.strike + row.instrument_type] = row;
              $scope.optionInstruments.strikes.push(row.strike);
            }
          });
          $scope.optionInstruments.strikes = Array.from(new Set($scope.optionInstruments.strikes)).sort((a, b) => (a - b));
          let atm_strike = $scope.instruments[$scope.selectedInstrument].per_expiry_data[$scope.expirySelected].strike;
          let atm_strike_index = $scope.optionInstruments.strikes.indexOf(atm_strike);
          let right_index = (atm_strike_index + ($scope.limitStrikes + 1));
          let left_index = atm_strike_index - ($scope.limitStrikes);
          $scope.optionInstruments.strikes.splice(right_index);
          $scope.optionInstruments.strikes.splice(0, left_index);
          $scope.loadingBtn = false;
          $scope.getLivePrices($scope.selectedInstrument);
        });
    }

    $scope.expiry_available = [];
    $scope.updateExpiry = function () {
      let instrument = $scope.instruments[$scope.selectedInstrument];
      $scope.expiry_available = Object.keys(instrument.per_expiry_data);
      $scope.futureInstruments = Object.values(instrument.per_expiry_data);
      $scope.futureInstruments = $scope.futureInstruments.sort(function (a, b) {
        return a.daysToExpiry - b.daysToExpiry;
      });
      if (!$scope.expirySelected) {
        $scope.expirySelected = $scope.futureInstruments[0].expiry;
      }
      $scope.lot_size = $scope.futureInstruments[0].lot_size;
      $scope.getInstrumentDetails($scope.selectedInstrument);
      $scope.showFutTbl = true;
      $scope.showOptTbl = true;
      let expiry_ivs = Object.values(instrument.per_expiry_data).reduce((obj, val) => {
        $scope.tokenToSymbol[val.future_instrument_token] = val.future_symbol;
        obj[val.expiry] = val.impliedVolatility;
        return obj;
      }, {});
      let futures_per_expiry = Object.values(instrument.per_expiry_data).reduce((obj, val) => {
        obj[val.expiry] = val.futurePrice;
        return obj;
      }, {});

      // $scope.socket = ticker.fn();
      $scope.connectSocket();

      $scope.resetStrategy();
    }

    function uuidv4() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0,
          v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    }
    $scope.strategy = {};
    $scope.addToTrade = function (instrument, instrument_type, trade_side) {
      let trade = {
        trade_action: trade_side.toUpperCase(),
        quantity: 1,
      };

      // if (instrument_type == 'future') {
      // trade.instrument_token = instrument.future_instrument_token;
      // trade.entry_price = instrument.futurePrice;
      // trade.implied_volatility = 0;
      // $scope.strategy.trades.push(trade);
      // } else 
      if (instrument_type == 'option') {
        trade.instrument_token = instrument.instrument_token;
        trade.shortname = instrument.strike + instrument.instrument_type;
        trade.tradingsymbol = instrument.tradingsymbol;
        trade.underlying = instrument.underlying;
        trade.expiry = instrument.expiry;
        trade.instrument_type = instrument.instrument_type;
        trade.lot_size = instrument.lot_size;
        trade.strike = instrument.strike;
        $scope.strategy.trades.push(trade);
        console.log(trade);
        $scope.subscribe([instrument.instrument_token]);
      }
    }

    $scope.updateQty = function (idx) {
      let qty = prompt('Quantity?', $scope.strategy.trades[idx].quantity);
      if (parseInt(qty) > 0) {
        $scope.strategy.trades[idx].quantity = parseInt(qty);
      }
    }

    $scope.removeTrade = function (idx) {
      if (confirm("Sure?")) {
        $scope.strategy.trades.splice(idx, 1);
      }
    }

    $scope.subscribe = function (tokens) {
      $scope.socket.subscribe(tokens);
      $scope.socket.setMode('ltp', tokens);
    }

    $scope.calculateSpreads = function () {
      if ($scope.strategy.trades && $scope.strategy.trades.length > 0) {
        $scope.strategy.last_price = $scope.strategy.trades.reduce(function (spread, trade) {
          if (typeof $scope.instrumentsLtp[trade.instrument_token] == 'number') {
            if (trade.trade_action == 'BUY') {
              spread -= $scope.instrumentsLtp[trade.instrument_token] * trade.quantity;
            } else if (trade.trade_action == 'SELL') {
              spread += $scope.instrumentsLtp[trade.instrument_token] * trade.quantity;
            }
          }
          return spread;
        }, 0);
        $scope.strategy.last_price = Math.round($scope.strategy.last_price * 10) / 10;
      }
    }

    $scope.connectSocket = function () {
      // // console.log('connecting from main')
      // if ($scope.socket.connected()) {
      //   // console.log('Subscribing');
      //   $rootScope.ticker.on("ticks", $scope.onTicks);
      // } else {
      //   $scope.socket = ticker.fn();
      //   // console.log('not connected');
      //   $timeout($scope.connectSocket, 1000);
      // }
    }

    $scope.instrumentsLtp = {};
    $scope.onTicks = function (ticks) {
      Object.assign($scope.instrumentsLtp, ticks);
      $scope.calculateSpreads();
    }
    ChangeStream.on('ticks', $scope.onTicks);

    // Cleanup event listeners when controller is destroyed
    $scope.$on('$destroy', function() {
      ChangeStream.off('ticks', $scope.onTicks);
    });

    $scope.resetStrategy = function () {
      let instrument = $scope.instruments[$scope.selectedInstrument];
      $scope.strategy = {
        underlying_token: instrument.instrument_token,
        current_underlying_price: instrument.last_price,
        leap: 0,
        per_trade: 1,
        total_quantity: 1,
        entry_quantity: 0,
        exit_quantity: 0,
        type: 'mis',
        status: 'New',
        name: 'Spreads-' + parseInt(Math.random() * 1000),
        trades: []
      }
    }
    $scope.saveStrategy = function () {
      $scope.strategy.entry_price = parseFloat($scope.strategy.entry_price);
      $scope.strategy.exit_price = parseFloat($scope.strategy.exit_price);
      $scope.strategy.total_quantity = parseFloat($scope.strategy.total_quantity);
      $scope.strategy.leap = parseFloat($scope.strategy.leap);
      $scope.strategy.per_trade = parseFloat($scope.strategy.per_trade);
      $scope.strategy.running = false;

      Spreads
        .create($scope.strategy)
        .$promise
        .then(function (resp) {
          console.log(resp);
          alert('Added');
        });
    }

    $scope.abs = (n) => roundOff(Math.abs(n));
  })

  .controller("ComboListController", function ($scope, $timeout, $rootScope, PaperTrade, ChangeStream, Spreads, $stateParams) {

    $scope.editStg = function (strategy, field, name) {
      let val = prompt(name, strategy[field]);
      if (confirm('Confirm Change')) {
        strategy[field] = parseFloat(val);
        strategy.$save();
      }
    }

    $scope.deleteStg = function (strategy, idx) {
      if (confirm('Confirm Delete?')) {
        Spreads
          .deleteById({
            id: strategy.id
          })
          .$promise
          .then(function (status) {
            console.log(status);
            $scope.strategies.splice(idx, 1);
            alert('Deleted');
          })
      }
    }

    $scope.updateStg = function (strategy, field, val) {
      strategy[field] = val;
      strategy.$save();
    }

    $scope.calculateSpreads = function () {
      if ($scope.strategies.length > 0) {
        $scope.strategies.forEach(function (strategy) {
          strategy.last_price = strategy.trades.reduce(function (spread, trade) {
            if (typeof $scope.instrumentsLtp[trade.instrument_token] == 'number') {
              if (trade.trade_action == 'BUY') {
                spread -= $scope.instrumentsLtp[trade.instrument_token] * trade.quantity;
              } else if (trade.trade_action == 'SELL') {
                spread += $scope.instrumentsLtp[trade.instrument_token] * trade.quantity;
              }
            }
            return spread;
          }, 0);
          strategy.last_price = Math.round(strategy.last_price * 10) / 10;
        });
      }
    }

    $scope.connectSocket = function () {
      // if ($scope.socket.connected()) {
      //   // console.log('Subscribing');
      //   let tokens = $scope.strategies.reduce(function (tokens, strategy) {
      //     let strategyTokens = strategy.trades.map(function (trade) {
      //       return trade.instrument_token;
      //     });
      //     tokens.push(...strategyTokens);
      //     return tokens;
      //   }, []);
      //   $scope.socket.subscribe(tokens);
      //   $scope.socket.setMode('ltp', tokens);
      //   $rootScope.ticker.on("ticks", $scope.onTicks);
      // } else {
      //   $scope.socket = ticker.fn();
      //   // console.log('not connected');
      //   $timeout($scope.connectSocket, 1000);
      // }
      ChangeStream.emit('get_ticks');
    }

    $scope.instrumentsLtp = {};
    $scope.onTicks = function (ticks) {
      Object.assign($scope.instrumentsLtp, ticks);
      $scope.calculateSpreads();
    }
    ChangeStream.on('ticks', $scope.onTicks);

    // Cleanup event listeners when controller is destroyed
    $scope.$on('$destroy', function() {
      ChangeStream.off('ticks', $scope.onTicks);
    });

    $scope.getData = function () {
      Spreads
        .find()
        .$promise
        .then(function (resp) {
          $scope.strategies = resp;
          // $scope.socket = ticker.fn();
          $scope.connectSocket();
        });
    }
    $scope.getData();

  });
