angular.module('app')
  .factory('ticker', function ($window, $rootScope) {
    // console.log($rootScope.public_token);
    $rootScope.ticker = new KiteTicker({});

    function start() {
      // console.log('token', $rootScope.public_token);
      // $rootScope.ticker = new KiteTicker({
      //   api_key: 'kitefront',
      //   access_token: $rootScope.public_token
      // });
      // $rootScope.ticker.connect();

      // $rootScope.ticker.on('connect', function () {
      // });
    }

    return {
      start: start,
      fn: function () {
        return $rootScope.ticker;
      },
      on: function (eventName, callback) {
        $rootScope.ticker.on(eventName, function () {
          var args = arguments;
          $rootScope.$apply(function () {
            callback.apply($rootScope.ticker, args);
          });
        });
      },
      emit: function (eventName, data, callback) {
        $rootScope.ticker.emit(eventName, data, function () {
          var args = arguments;
          $rootScope.$apply(function () {
            if (callback) {
              callback.apply($rootScope.ticker, args);
            }
          });
        })
      }
    };
  });