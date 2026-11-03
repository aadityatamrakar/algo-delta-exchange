angular
  .module('app', [
    'lbServices',
    'ui.router',
    'angular-loading-bar'
  ])
  .config(['$stateProvider', '$urlRouterProvider', '$httpProvider', '$sceDelegateProvider', function ($stateProvider,
    $urlRouterProvider, $httpProvider, $sceDelegateProvider) {

    // $sceDelegateProvider.resourceUrlWhitelist(['^(?:http(?:s)?:\/\/)?(?:[^\.]+\.)?\(SMP)\.in(/.*)?$', 'self']);
    // $sceDelegateProvider.trustedResourceUrlList([
    //   'self',
    //   '**.SMP.in/**'
    // ]);

    $httpProvider.interceptors.push(function ($q, $location, LoopBackAuth) {
      return {
        responseError: function (rejection) {
          if (rejection.status == 401) {
            LoopBackAuth.clearUser();
            LoopBackAuth.clearStorage();
            $location.nextAfterLogin = $location.path();
            $location.path('/login');
          }
          return $q.reject(rejection);
        }
      };
    });

    $httpProvider.interceptors.push(function ($q, $location, LoopBackAuth) {
      return {
        responseError: function (rejection) {
          return $q.reject(rejection);
        }
      };
    });

    // let viewsURL = 'https://cdn.SMP.in/';
    let viewsURL = '';
    $stateProvider
      .state('app', {
        abstract: true,
        url: '/app',
        templateUrl: viewsURL + 'views/wrapper.html',
        controller: 'AppController'
      })
      .state('app.home', {
        url: '/home',
        templateUrl: viewsURL + 'views/home.html',
        controller: 'HomeController'
      })
      .state('app.pricing', {
        url: '/pricing',
        templateUrl: viewsURL + 'views/pricing.html',
        // controller: 'HomeController'
      })
      .state('app.builder', {
        url: '/strategy-builder',
        templateUrl: viewsURL + 'views/builder.html',
        controller: 'BuilderController'
      })
      .state('app.combo', {
        url: '/combo-builder',
        templateUrl: viewsURL + 'views/combo.html',
        controller: 'ComboController'
      })
      .state('app.parity', {
        url: '/nymex-mcx',
        templateUrl: viewsURL + 'views/ibkr_parity.html',
        controller: 'ParityController'
      })
      .state('app.combo_list', {
        url: '/combo-list',
        templateUrl: viewsURL + 'views/combo_list.html',
        controller: 'ComboListController'
      })
      .state('app.spreads', {
        url: '/strategy-spreads',
        templateUrl: viewsURL + 'views/spreads.html',
        controller: 'SpreadsController'
      })
      .state('app.screener', {
        url: '/live-algos',
        templateUrl: viewsURL + 'views/screener.html',
        controller: 'ScreenerController',
        onEnter: function () {
          document.title = 'Screener | SMP';
        }
      })
      .state('app.strategies', {
        url: '/strategies',
        templateUrl: viewsURL + 'views/strategies.html',
        controller: 'StrategyController'
      })
      .state('app.manager', {
        url: '/manager',
        templateUrl: viewsURL + 'views/manager.html',
        controller: 'ManagerController'
      })
      .state('app.allorders', {
        url: '/orderbook',
        templateUrl: viewsURL + 'views/allorders.html',
        controller: 'AllOrdersController'
      })
      .state('app.mysummary', {
        url: '/my-summary',
        templateUrl: viewsURL + 'views/mysummary.html',
        controller: 'ClientSummaryController'
      })
      .state('app.settings', {
        url: '/settings',
        templateUrl: viewsURL + 'views/settings.html',
        controller: 'SettingsController'
      })
      .state('app.users', {
        url: '/users',
        templateUrl: viewsURL + 'views/users.html',
        controller: 'UsersController'
      })
      .state('app.circuit', {
        url: '/circuit',
        templateUrl: viewsURL + 'views/circuit.html',
        controller: 'CircuitController'
      })
      .state('app.accounts', {
        url: '/accounts',
        templateUrl: viewsURL + 'views/accounts.html',
        controller: 'AccountsController'
      })
      .state('app.positions', {
        url: '/positions/:platform/:accountId/:name/:full_name/:ts',
        templateUrl: viewsURL + 'views/positions.html',
        controller: 'PositionsController',
        onEnter: function ($stateParams) {
          if ($stateParams['platform'] == 'paper') {
            document.title = $stateParams['accountId'] + ' | SMP';
            gtag('event', 'page_view', {
              page_title: "STG:" + $stateParams['accountId']
            });
          } else {
            document.title = 'Positions | SMP';
            gtag('event', 'page_view', {
              page_title: 'Positions'
            });
          }
        }
      })
      .state('app.allpnl', {
        url: '/accounts-summary',
        templateUrl: viewsURL + 'views/all_pnl.html',
        controller: 'AccountPNLController',
        onEnter: function () {
          document.title = 'PNL | SMP';
          gtag('event', 'page_view', {
            page_title: 'PNL'
          })
        }
      })
      .state('app.mystrategies', {
        url: '/my-strategies',
        templateUrl: viewsURL + 'views/mystrategies.html',
        controller: 'UserStrategiesController',
        onEnter: function () {
          document.title = 'My Strategies | SMP';
          gtag('event', 'page_view', {
            page_title: 'My Strategies'
          })
        }
      })
      .state('app.papertrading', {
        url: '/paper-trading',
        templateUrl: viewsURL + 'views/paper.html',
        controller: 'PaperController',
      })
      .state('app.positional', {
        url: '/positional',
        templateUrl: viewsURL + 'views/positional.html',
        controller: 'PositionalController',
      })
      .state('app.reports', {
        url: '/reports',
        templateUrl: viewsURL + 'views/reports.html',
        controller: 'ReportsController',
        onEnter: function () {
          document.title = 'Reports | SMP';
          gtag('event', 'page_view', {
            page_title: 'Reports'
          })
        }
      })
      .state('app.performance', {
        url: '/performance',
        templateUrl: viewsURL + 'views/performance.html',
        controller: 'PerformanceController',
        onEnter: function () {
          document.title = 'Performance | SMP';
          gtag('event', 'page_view', {
            page_title: 'Performance'
          })
        }
      })
      .state('login', {
        url: '/login',
        templateUrl: viewsURL + 'views/login.html',
        controller: 'LoginController',
        onEnter: function () {
          document.title = 'Login | SMP';
          gtag('event', 'page_view', {
            page_title: 'Login'
          })
        }
      })
      .state('register', {
        url: '/register',
        templateUrl: viewsURL + 'views/register.html',
        controller: 'LoginController',
        onEnter: function () {
          document.title = 'Register | SMP';
          gtag('event', 'page_view', {
            page_title: 'Register'
          })
        }
      });

    $urlRouterProvider.otherwise('/login');
  }]);
