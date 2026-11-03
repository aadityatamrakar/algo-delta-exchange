angular
  .module("app")

  .controller("PerformanceController", function ($scope, $rootScope, $interval, $state, $timeout, Report, XtsAccount, Client, Account) {
    $scope.clientCode = '';
    $scope.reports = [];
    $scope.totalPnl = 0;
    $scope.getData = function () {
      let query = {};
      query.clientCode = "algomaker";
      Report.find({
        filter: {
          where: query,
          order: 'ts asc'
        }
      }).$promise.then(function (resp) {
        resp = resp.reduce(function (summary, row) {
          if (!summary[$rootScope.parseDate(row.ts)]) summary[$rootScope.parseDate(row.ts)] = 0;
          summary[$rootScope.parseDate(row.ts)] += row.pnl;
          return summary;
        }, {});
        let pnlCummulative = 0;
        $scope.reports = Object.keys(resp).map(function (dt) {
          pnlCummulative += resp[dt];
          return {
            x: dt,
            y: resp[dt],
            c: pnlCummulative
          };
        });
        $scope.totalPnl = pnlCummulative;
        $scope.drawChart($scope.reports);
      });
    };
    $scope.getData();

    $scope.drawChart = function (rawdata) {
      let cummPnl = 0;
      rawdata = rawdata.map(c => ({
        time: c.x,
        value: cummPnl += c.y
      }));

      var container = document.getElementById('report_chart');
      container.innerHTML = '';
      var width = container.clientWidth;
      var height = 400;
      var chart = LightweightCharts.createChart(container, {
        width: width,
        height: height,
        timeScale: {
          borderVisible: false,
        },
        grid: {
          horzLines: {
            color: '#eee',
            visible: false,
          },
          vertLines: {
            color: '#ffffff',
          },
        },
        crosshair: {
          horzLine: {
            visible: false,
            labelVisible: false
          },
          vertLine: {
            visible: true,
            style: 0,
            width: 2,
            color: 'rgba(32, 38, 46, 0.1)',
            labelVisible: false,
          }
        },
      });

      var series = chart.addAreaSeries({
        topColor: 'rgba(19, 68, 193, 0.4)',
        bottomColor: 'rgba(0, 120, 255, 0.0)',
        lineColor: 'rgba(19, 40, 153, 1.0)',
        lineWidth: 3,
        priceLineVisible: false,
        priceScaleId: 'right',
        scaleMargins: {
          top: 0.2,
          bottom: 0.05,
        },
        priceFormat: {
          type: 'volume',
          precision: 0,
          minMove: 1,
        }
      });
      series.setData(rawdata);
      chart.timeScale().fitContent();
    }
  })
  .controller("UserStrategiesController", function ($scope, $rootScope, $interval, $state, $timeout, Report, Account, Client, Strategy) {

    $scope.cardStyle = {
      'background-size': $rootScope.isMobileDevice() ? 'contain' : 'cover',
      'background-position': 'bottom'
    };

    $scope.strategies = [];

    $scope.getStrategies = function () {
      Strategy.find({})
        .$promise
        .then(function (strategies) {
          $scope.strategies = strategies;
        });
    }
    $scope.getStrategies();

    $scope.changeQuantity = function (strategy) {
      $scope.strategy = strategy;
      if ($scope.currentSize && $scope.currentSize[strategy.title]) {
        $scope.lotSize = $scope.currentSize[strategy.title];
      }
      $('#mutliplierModal').modal('show');
    }

    $scope.updateQuantity = function () {
      if (!$scope.currentSize) $scope.currentSize = {};
      $scope.currentSize[$scope.strategy.title] = $scope.lotSize;
      $scope.account.strategy = $scope.currentSize;
      $scope.account.$save();
      $('#mutliplierModal').modal('hide');
    }

    $scope.strategy = 'Tesla';
    $('#strategyModal').on('hidden.bs.modal', function (e) {
      var container = document.getElementById('strategyPnlChart');
      container.innerHTML = "<p class='text-center'>Loading Chart...</p>";
    });
    $('#strategyModal').on('shown.bs.modal', function (e) {
      Report.find({
        filter: {
          where: {
            clientCode: $scope.strategy
          },
          order: 'ts asc'
        }
      }).$promise.then(function (resp) {
        resp = resp.reduce(function (summary, row) {
          if (!summary[moment(row.ts).format('X')]) summary[moment(row.ts).format('X')] = 0;
          summary[moment(row.ts).format('X')] += row.pnl;
          return summary;
        }, {});
        let pnlCummulative = 0;
        $scope.reports = Object.keys(resp).map(function (dt) {
          pnlCummulative += resp[dt];
          return {
            x: parseInt(dt),
            y: resp[dt],
            c: pnlCummulative
          };
        });
        $scope.totalPnl = pnlCummulative;
        $scope.drawChart($scope.reports);
      });
    });

    $scope.strategyReport = function (strategy) {
      $scope.strategy = strategy;
      $('#strategyModal').modal('show');
    }

    $scope.drawChart = function (rawdata) {
      let cummPnl = 0;
      rawdata = rawdata.map(c => ({
        time: c.x,
        value: cummPnl += c.y
      }));
      // console.log(rawdata);
      var container = document.getElementById('strategyPnlChart');
      container.innerHTML = "";
      var width = container.clientWidth;
      var height = 400;
      var chart = LightweightCharts.createChart(container, {
        width: width,
        height: height,
        watermark: {
          color: 'rgba(0, 0, 0, 0.25)',
          visible: true,
          text: "AlgoMaker",
          fontSize: $rootScope.isMobileDevice() ? 24 : 40,
          fontFamily: 'Goldman',
          horzAlign: 'center',
          vertAlign: 'center',
        },
        timeScale: {
          borderVisible: false,
        },
        grid: {
          horzLines: {
            color: '#eee',
            visible: false,
          },
          vertLines: {
            color: '#ffffff',
          },
        },
        crosshair: {
          horzLine: {
            visible: false,
            labelVisible: false
          },
          vertLine: {
            visible: true,
            style: 0,
            width: 2,
            color: 'rgba(32, 38, 46, 0.1)',
            labelVisible: false,
          }
        },
      });

      var series = chart.addAreaSeries({
        topColor: 'rgba(19, 68, 193, 0.4)',
        bottomColor: 'rgba(0, 120, 255, 0.0)',
        lineColor: 'rgba(19, 40, 153, 1.0)',
        lineWidth: 3,
        priceLineVisible: false,
        priceScaleId: 'right',
        scaleMargins: {
          top: 0.2,
          bottom: 0.05,
        },
        priceFormat: {
          type: 'volume',
          precision: 0,
          minMove: 1,
        }
      });
      series.setData(rawdata);
      chart.timeScale().fitContent();
    }


    $scope.saveAccount = function () {
      $scope.account.clientId = Client.getCurrentId();
      if ($scope.account.credentials && $scope.account.credentials.user_id) {
        $scope.account.credentials.user_id = String($scope.account.credentials.user_id).toUpperCase();
        $scope.account.name = String($scope.account.credentials.user_id).toUpperCase();
      }
      Account.check({
          account: $scope.account
        })
        .$promise
        .then(function (resp) {
          if (resp.status) {
            if ($scope.account.username == '' || !$scope.account.username) {
              $scope.account.username = resp.profile.data.user_name;
            }
            $scope.account.config = resp.profile;
            $scope.account.margins = resp.margins;
            Client.accounts
              .create({
                id: Client.getCurrentId()
              }, $scope.account)
              .$promise
              .then(function (resp) {
                $scope.accountAdded = true;
                $('#addAccount').modal('hide');
              }).catch(function (err) {
                alert(err.data.error.message);
              });
          } else alert(resp.message);
        });
    }

    $scope.currentSize = {};
    $scope.accountAdded = false;
    $scope.getAccount = function () {
      Client
        .accounts({
          id: Client.getCurrentId()
        })
        .$promise
        .then(function (accounts) {
          if (accounts.length > 0) {
            $scope.accountAdded = true;
            $scope.account = accounts[0]
            $scope.currentSize = $scope.account.strategy;
          } else {
            $scope.account = {
              config: {}
            };
          }
        });
    }
    $scope.getAccount();
  });
