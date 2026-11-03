angular
  .module("app")
  .controller("PaperController", function ($scope, $timeout, $rootScope, PaperTrade, ChangeStream, Account, $stateParams) {
    $scope.accounts = [];
    $scope.total_pnl = 0;
    $scope.positionInstruments = {};
    $scope.loadingPositions = false;
    console.log('hello');

    ChangeStream.on('paper-update', function (resp) {
      $scope.accounts = resp.accounts;
      $scope.connectSocket();
      $scope.getDayPNL();
    });

    $scope.getDayPNL = function () {
      $scope.total_pnl = 0;
      $scope.accounts.forEach(function (account, idx) {
        $scope.accounts[idx].total = $scope.accounts[idx].positions.reduce(function (total, position) {
          return total + position.m2m;
        }, 0);
        $scope.accounts[idx].totalAbs = Math.abs($scope.accounts[idx].total);
        $scope.total_pnl += $scope.accounts[idx].total;
      });
    }

    $scope.connectSocket = function () {
      // // console.log('connecting from main')
      // if ($scope.socket.connected()) {
      //   // console.log('Subscribing');
      //   let allTokens = $scope.accounts.map(function (account) {
      //     return account.positions.map(function (position) {
      //       return parseInt(position.instrument_token);
      //     })
      //   });
      //   allTokens = Array.from(new Set([].concat.apply([], allTokens)));
      //   console.log(allTokens);
      //   $scope.socket.subscribe(allTokens);
      //   $scope.socket.setMode('ltp', allTokens);
      //   $rootScope.ticker.on("ticks", $scope.onTicks);
      // } else {
      //   $scope.socket = ticker.fn();
      //   // console.log('not connected');
      //   $timeout($scope.connectSocket, 1000);
      // }
      ChangeStream.emit('get_ticks');
    }

    $scope.onTicks = function (ticks) {
      Object.assign($scope.positionInstruments, ticks);
      $scope.updatePositionsPNL($scope.positionInstruments);
    }
    ChangeStream.on('ticks', $scope.onTicks);

    // Cleanup event listeners when controller is destroyed
    $scope.$on('$destroy', function() {
      ChangeStream.off('ticks', $scope.onTicks);
      ChangeStream.off('paper-update');
    });

    $scope.updatePositionsPNL = function (instrument_ltp) {
      $scope.total_pnl = 0;
      $scope.accounts.forEach(function (account, idx) {
        let total_m2m = 0;
        $scope.accounts[idx].positions.forEach(function (position) {
          if (instrument_ltp[position.instrument_token]) {
            if (position.quantity > 0) {
              position.m2m = ((position.sell_price * position.sell_quantity) + (Math.abs(position.quantity) * instrument_ltp[position.instrument_token])) - (position.buy_price * position.buy_quantity);
            } else if (position.quantity < 0) {
              position.m2m = (position.sell_price * position.sell_quantity) - ((position.buy_price * position.buy_quantity) + (Math.abs(position.quantity) * instrument_ltp[position.instrument_token]));
            }
          }
          total_m2m += position.m2m;
        });
        $scope.accounts[idx].total = total_m2m;
        $scope.accounts[idx].totalAbs = Math.abs($scope.accounts[idx].total);
        $scope.total_pnl += total_m2m;
      });
    }

    $scope.getPositions = function () {
      $scope.loadingPositions = true;
      $scope.accounts = [];
      $scope.loadingDash = true;

      PaperTrade.positions().$promise.then(function (resp) {
        $scope.accounts = resp.accounts;
        // $scope.socket = ticker.fn();
        $scope.connectSocket();
        $scope.getDayPNL();
      });
    }
    $scope.getPositions();
  })

  .controller("PositionalController", function ($scope, $timeout, $rootScope, PaperTrade, Positional, ChangeStream, Account, $stateParams) {
    $scope.accounts = [];
    $scope.total_pnl = 0;
    $scope.positionInstruments = {};
    $scope.loadingPositions = false;
    console.log('hello');
    
    $scope.getDayPNL = function () {
      $scope.total_pnl = 0;
      $scope.accounts.forEach(function (account, idx) {
        $scope.accounts[idx].total = $scope.accounts[idx].positions.reduce(function (total, position) {
          return total + position.m2m;
        }, 0);
        $scope.accounts[idx].totalAbs = Math.abs($scope.accounts[idx].total);
        $scope.total_pnl += $scope.accounts[idx].total;
      });
    }

    $scope.connectSocket = function () {
      // // console.log('connecting from main')
      // if ($scope.socket.connected()) {
      //   // console.log('Subscribing');
      //   let allTokens = $scope.accounts.map(function (account) {
      //     return account.positions.map(function (position) {
      //       return parseInt(position.instrument_token);
      //     })
      //   });
      //   allTokens = Array.from(new Set([].concat.apply([], allTokens)));
      //   console.log(allTokens);
      //   $scope.socket.subscribe(allTokens);
      //   $scope.socket.setMode('ltp', allTokens);
      //   $rootScope.ticker.on("ticks", $scope.onTicks);
      // } else {
      //   // $scope.socket = ticker.fn();
      //   // console.log('not connected');
      //   $timeout($scope.connectSocket, 1000);
      // }
      ChangeStream.emit('get_ticks');
    }

    $scope.onTicks = function (ticks) {
      Object.assign($scope.positionInstruments, ticks);
      $scope.updatePositionsPNL($scope.positionInstruments);
    }
    ChangeStream.on('ticks', $scope.onTicks);

    // Cleanup event listeners when controller is destroyed
    $scope.$on('$destroy', function() {
      ChangeStream.off('ticks', $scope.onTicks);
    });

    $scope.updatePositionsPNL = function (instrument_ltp) {
      $scope.total_pnl = 0;
      $scope.accounts.forEach(function (account, idx) {
        let total_m2m = 0;
        $scope.accounts[idx].positions.forEach(function (position) {
          if (instrument_ltp[position.instrument_token]) {
            if (position.quantity > 0) {
              position.m2m = ((position.sell_price * position.sell_quantity) + (Math.abs(position.quantity) * instrument_ltp[position.instrument_token])) - (position.buy_price * position.buy_quantity);
            } else if (position.quantity < 0) {
              position.m2m = (position.sell_price * position.sell_quantity) - ((position.buy_price * position.buy_quantity) + (Math.abs(position.quantity) * instrument_ltp[position.instrument_token]));
            }
          }
          total_m2m += position.m2m;
        });
        $scope.accounts[idx].total = total_m2m;
        $scope.accounts[idx].totalAbs = Math.abs($scope.accounts[idx].total);
        $scope.total_pnl += total_m2m;
      });
    }

    $scope.getPositions = function () {
      $scope.loadingPositions = true;
      $scope.accounts = [];
      $scope.loadingDash = true;

      Positional.positions().$promise.then(function (resp) {
        $scope.accounts = resp.accounts;
        // $scope.socket = ticker.fn();
        $scope.connectSocket();
        $scope.getDayPNL();
      });
    }
    $scope.getPositions();
  })
