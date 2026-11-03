angular
  .module("app")

  .controller("AppController", function ($scope, $rootScope, $interval, $state, $timeout, Client, ChangeStream, Account) {
    $scope.logout = function () {
      Client.logout().$promise.then(function () {
        $state.go('login');
      });
    }

    $rootScope.listenerServices = {
      all_pnl: false,
      positions_pnl: false
    };
    $rootScope.currentAccountName = '';

    $scope.roundOff = function (amount) {
      return String(parseInt(amount)).replace(/(\d)(?=(\d\d)+\d$)/g, "$1,")
    }

    $scope.gotoHome = function () {
      if ($rootScope.superadmin) $state.go("app.allpnl");
      else $state.go("app.papertrading");
    }

    $rootScope.isMobileDevice = function () {
      let check = false;
      (function (a) {
        if (/(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|iris|kindle|lge |maemo|midp|mmp|mobile.+firefox|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows ce|xda|xiino/i.test(a) || /1207|6310|6590|3gso|4thp|50[1-6]i|770s|802s|a wa|abac|ac(er|oo|s\-)|ai(ko|rn)|al(av|ca|co)|amoi|an(ex|ny|yw)|aptu|ar(ch|go)|as(te|us)|attw|au(di|\-m|r |s )|avan|be(ck|ll|nq)|bi(lb|rd)|bl(ac|az)|br(e|v)w|bumb|bw\-(n|u)|c55\/|capi|ccwa|cdm\-|cell|chtm|cldc|cmd\-|co(mp|nd)|craw|da(it|ll|ng)|dbte|dc\-s|devi|dica|dmob|do(c|p)o|ds(12|\-d)|el(49|ai)|em(l2|ul)|er(ic|k0)|esl8|ez([4-7]0|os|wa|ze)|fetc|fly(\-|_)|g1 u|g560|gene|gf\-5|g\-mo|go(\.w|od)|gr(ad|un)|haie|hcit|hd\-(m|p|t)|hei\-|hi(pt|ta)|hp( i|ip)|hs\-c|ht(c(\-| |_|a|g|p|s|t)|tp)|hu(aw|tc)|i\-(20|go|ma)|i230|iac( |\-|\/)|ibro|idea|ig01|ikom|im1k|inno|ipaq|iris|ja(t|v)a|jbro|jemu|jigs|kddi|keji|kgt( |\/)|klon|kpt |kwc\-|kyo(c|k)|le(no|xi)|lg( g|\/(k|l|u)|50|54|\-[a-w])|libw|lynx|m1\-w|m3ga|m50\/|ma(te|ui|xo)|mc(01|21|ca)|m\-cr|me(rc|ri)|mi(o8|oa|ts)|mmef|mo(01|02|bi|de|do|t(\-| |o|v)|zz)|mt(50|p1|v )|mwbp|mywa|n10[0-2]|n20[2-3]|n30(0|2)|n50(0|2|5)|n7(0(0|1)|10)|ne((c|m)\-|on|tf|wf|wg|wt)|nok(6|i)|nzph|o2im|op(ti|wv)|oran|owg1|p800|pan(a|d|t)|pdxg|pg(13|\-([1-8]|c))|phil|pire|pl(ay|uc)|pn\-2|po(ck|rt|se)|prox|psio|pt\-g|qa\-a|qc(07|12|21|32|60|\-[2-7]|i\-)|qtek|r380|r600|raks|rim9|ro(ve|zo)|s55\/|sa(ge|ma|mm|ms|ny|va)|sc(01|h\-|oo|p\-)|sdk\/|se(c(\-|0|1)|47|mc|nd|ri)|sgh\-|shar|sie(\-|m)|sk\-0|sl(45|id)|sm(al|ar|b3|it|t5)|so(ft|ny)|sp(01|h\-|v\-|v )|sy(01|mb)|t2(18|50)|t6(00|10|18)|ta(gt|lk)|tcl\-|tdg\-|tel(i|m)|tim\-|t\-mo|to(pl|sh)|ts(70|m\-|m3|m5)|tx\-9|up(\.b|g1|si)|utst|v400|v750|veri|vi(rg|te)|vk(40|5[0-3]|\-v)|vm40|voda|vulc|vx(52|53|60|61|70|80|81|83|85|98)|w3c(\-| )|webc|whit|wi(g |nc|nw)|wmlb|wonu|x700|yas\-|your|zeto|zte\-/i.test(a.substr(0, 4))) check = true;
      })(navigator.userAgent || navigator.vendor || window.opera);
      return check;
    };

    $rootScope.liveStrategies = [
      "1PBUY", "CheetahB1-1", "CheetahB1-2", "SNX_HFT_SELL", "SNX_HFT_AVG", "BN_HFT_AVG", "NF_HFT_AVG", "SNX_HFT_MUL", "TGT15", "A003", "A006", "EMA2050", "CP_B_2040", "CP_S_2040", "CP_S_030", "CP_NS_2040", "CP_SNX_2040", "CP_SNX_030", "CP_S_010", "CP_RS_030", "FUTURE-100", "Lion_B25_1", "Lion_ST25-1", "Lion_SP5-1", "Eagle_P-1", "Eagle_S-1", "Eagle_S-2", "Eagle_S-3", "Eagle_S-4", "Bull_S-1", "Fox-1", "CE_D2_E", "PE_D2_E", "CE_D2P_E", "PE_D2P_E", "Lion_S25_1", "Lion_S25_2", "Lion_S25_3", "Lion_Up-1", "Lion_ST15_1", "Lion_ST15_2", "Lion_ST15_3", "Cheetah_B1_10", "Cheetah_B1_20", "Cheetah_B1_30", "Cheetah_SP_15", "Cheetah_SP_20", "Cheetah_SP_25", "Cheetah_S_10", "Cheetah_S_20", "Cheetah_S_75", "Cheetah_S_60", "Cheetah_ST_75", "Cheetah_ST_90", "Cheetah_S_90", "Cheetah_ST60_20m", "Cheetah_BF1_30", "Cheetah_BF1S_30", "Cheetah_NF1_15", "Lion_S_15", "Lion_ST_25", "Lion_S_25", "STGL-25", "STGL-M25", "Lion_ST_20", "Lion_S_20", "Lion_ST_15", "Opt_B", "Opt_BD", "Opt_S", "Nifty_S_25", "Nifty_S_50", "JK_S_25", "Lion_NS_25", "Cheetah_FUT_60", "Cheetah_FUT_90", "BigLion_S_25", "Rel_ORB", "Jaguar", "CE_D_2", "CE_D_3", "PE_D_2", "PE_D_3", "Tiger_S_5", "Eagle_S", "Eagle_SH", "Bull_S", "Lion_SH_25", "Lion_S_40", "Lion_B_25", "Lion_BP_3", "Lion_BP_4", "Lion_BP_5", "Lion_BP_6", "SamLion_9", "B300", "B300i", "N300", "N300i", "Bull_M", "Bull-10", "Eagle_P", "Lion_ZZJ11574", "STGL-25-2", "Bull_S-2", "Bull_M2", "B200", "B201", "Bull_S5-1", "Bull_S5-2", "RV-40n", "Bull_NS-1", "Bull_NS-2", "Eagle_NS-1", "Eagle_NS-2", "Lion_NS25_1", "Lion_NS25_2", "Bull_FS-1", "Bull_MS-1", "Eagle_MS-1", "Eagle_FS-1", "Lion_MS25_1", "Lion_FS25_1", "Bull_FS-2", "Bull_MS-2", "Eagle_MS-2", "Eagle_FS-2", "Lion_MS25_2", "Lion_FS25_2", "RV-40e1", "RV-40e2", "Lion_S25_2E", "Lion_S25_3E", "B200-1", "Bull_SNX", "Eagle_SNX", "Lion_SNX_25", "Bull_SNX-1", "Eagle_SNX-1", "Lion_SNX-1", "Bull_NS", "Eagle_NS", "Eagle_S",
      "Bull_S", "Eagle_P", "Eagle_NS", "Bull_NS", "SNX_HFT_DBL", "RV-40n", "BN_HFT_AVG", "NF_MULTI_STRADDLE", "SNX_TIMER_STRADDLE", "SNX_HFT_AVG", "BN_TIMER_STRADDLE", "SNX_TIMER_120", "NF_TIMER_120", "SNX_HFT_SGL", "BN_MULTI_STRADDLE", "NF_HFT_AVG", "NF_TIMER_STRADDLE", "BN_TIMER_120", "SNX_MULTI_STRADDLE", "STGL-3", "Bull_SNX", "Eagle_SNX", "Cheetah_B1_10", "Lion_S_40", "SamLion_9", "Lion_ST_15", "JK_S_25", "Lion_S_15", "Lion_ST_25", "Lion_S_25", "Lion_SNX_25", "STGL-25", "Strad_30T", "Nifty_S_50", "Nifty_S_25", "Falcon_S", "B201", "N300", "B300", "B300i", "N300i", "Bull-10",
      "B200", "Cheetah_B1_SNX", "CP_S_3370", "SNX_ORB_1", "SNX_ORB_25", "SNX_ORB_50",
      "ATR_Band_NIFTY", "ORB_Fut_NIFTY","ORB_Fut_BankNifty","ORB_Fut_Sensex","BN_Breakout","ORB_SCALP_NIFTY","ORB_SCALP_BN","ORB_SCALP_SNX"];
    $rootScope.liveStrategies = Array.from(new Set($rootScope.liveStrategies)).sort();
    $rootScope.positionalStrategies = ["CE_D2P_E", "PE_D2P_E"];

    $rootScope.liveStrategies = Array.from(new Set($rootScope.liveStrategies));

    $rootScope.liveData = false;
    if (window.localStorage.getItem('liveData')) $rootScope.liveData = true;
    $rootScope.tickerConnected = false;
    $interval(function () {
      let currentDate = new Date();
      if ((currentDate.getDay() > 0 && currentDate.getDay() < 6) && (currentDate.getHours() > 8 && currentDate.getHours() < 16)) {
        if (currentDate.getHours() == 9 && currentDate.getMinutes() > 15) $rootScope.tickerConnected = true;
        else if (currentDate.getHours() == 15 && currentDate.getMinutes() < 31) $rootScope.tickerConnected = true;
        else if (currentDate.getHours() > 9 && currentDate.getHours() < 15) $rootScope.tickerConnected = true;
      }
    }, 1000);

    $scope.indexTicker = {
      256265: 0,
      260105: 0
    };

    $scope.connectSocket = function () {
      // // console.log('connecting from main')
      // if ($scope.socket.connected()) {
      //   // console.log('Subscribing');
      //   let allTokens = Object.keys($scope.indexTicker).map(c => parseInt(c));
      //   $scope.socket.subscribe(allTokens);
      //   $scope.socket.setMode('ltp', allTokens);
      //   $rootScope.ticker.on("ticks", $scope.onTicks);
      // } else {
      //   $scope.socket = ticker.fn();
      //   // console.log('not connected');
      //   $timeout($scope.connectSocket, 1000);
      // }
    }

    $scope.onTicks = function (ticks) {
      ticks.forEach(tick => {
        if (typeof $scope.indexTicker[tick.instrument_token] != 'undefined') {
          $scope.indexTicker[tick.instrument_token] = tick.last_price;
          $scope.$apply();
        }
      });
    }

    $rootScope.parseDate = function (ts) {
      return moment(ts).format('YYYY-MM-DD');
    }
    $rootScope.parseShortDate = function (ts) {
      if ($rootScope.isMobileDevice()) return moment(ts, 'YYYY-MM-DD').format('LL,ddd');
      else return moment(ts, 'YYYY-MM-DD').format('LL, dddd');
    }
    $rootScope.parseDay = function (ts) {
      return moment(ts, 'YYYY-MM-DD').format('dddd');
    }

    $rootScope.accountMapped = false;
    $rootScope.superadmin = false;
    $scope.getProfile = function () {
      Client.getCurrent()
        .$promise
        .then(function (user) {
          // console.log(user);
          $rootScope.superadmin = user.superadmin ? user.superadmin : false;
          $rootScope.liveUser = user.live ? user.live : false;
          $rootScope.viewPlatform = user.viewPlatform ? user.viewPlatform : false;
          $rootScope.execRights = user.execution ? user.execution : false;
          Account.token().$promise.then(function (resp) {
            if (resp.status) {
              $rootScope.public_token = resp.token;
              // ticker.start();
              // $scope.socket = ticker.fn();
              // $scope.connectSocket();
            }
          });
          Client
            .accounts({
              id: Client.getCurrentId()
            })
            .$promise
            .then(function (accounts) {
              if (accounts.length > 0) {
                $rootScope.accountMapped = true;
              }
            });
        });
    }

    $scope.getProfile();
  })

  .controller("CircuitController", function ($scope, $state, ChangeStream) {
    $scope.stocks = [];
    $scope.circuit_type = "all";
    
    $scope.onBseTracker = function (data) {
      $scope.stocks = data
        .filter(c => {
          if ($scope.circuit_type == "all") return true;
          else if ($scope.circuit_type == "uc" && c.p === c.uc) return true;
          else if ($scope.circuit_type == "lc" && c.p === c.lc) return true;
          else return false;
        })
        .sort((a, b) => (a.s > b.s) ? 1 : ((b.s > a.s) ? -1 : 0));
      $scope.$apply();
    };
    ChangeStream.on('bse_tracker', $scope.onBseTracker);

    // Cleanup event listeners when controller is destroyed
    $scope.$on('$destroy', function() {
      ChangeStream.off('bse_tracker', $scope.onBseTracker);
    });
  })
  .controller("SettingsController", function ($scope, $state, Client) {
    $scope.changePwd = function () {
      let clientId = Client.getCurrentId();
      if ($scope.newPassword && String($scope.newPassword).length != 4) alert('PIN Length should be 4 Digit, and should not start with 0.');
      else {
        Client.setPassword({
          id: clientId,
          newPassword: String($scope.newPassword)
        }).$promise.then(function (resp) {
          alert('Password Change Success!');
        });
      }
    }
  })
  .controller("AccountPNLController", function ($scope, $state, $timeout, $rootScope, XtsAccount, Account, SparkAccount, ChangeStream, $stateParams) {
    $scope.accounts = [];
    $scope.total_pnl = 0;
    $scope.positionInstruments = {};
    $scope.loadingPositions = false;


    $scope.cacheConfig = function () {
      $rootScope.liveData = !$rootScope.liveData;
      if ($rootScope.liveData) window.localStorage.setItem('liveData', true);
      else window.localStorage.removeItem('liveData');
    }

    if (!$rootScope.listenerServices['all_pnl']) {
      $rootScope.listenerServices['all_pnl'] = true;
      ChangeStream.on('positions-update', function () {
        if ($state.$current.name == 'app.allpnl') {
          $scope.getPositions();
        }
      });
    }

    $scope.loadingDash = false;
    $scope.currentView = 'ALL';
    $scope.changeView = function () {
      if ($scope.currentView == 'ALL') {
        $scope.currentView = 'XTS Only';
        $scope.viewPlatform = 'xts';
      } else if ($scope.currentView == 'XTS Only') {
        $scope.currentView = 'Zerodha Only';
        $scope.viewPlatform = 'zerodha';
      } else if ($scope.currentView == 'Zerodha Only') {
        $scope.currentView = 'ALL';
        $scope.viewPlatform = false;
      }
      $scope.getPositions();
    }

    $scope.tableStyle = {
      fontSize: 16
    };
    if ($rootScope.isMobileDevice()) {
      $scope.tableStyle = {
        fontSize: 14
      };
    }

    $scope.cashout = function () {
      let pinCheck = prompt('Cashout PIN?', '');
      if (String(pinCheck) == '2020' && confirm("Confirm Cashout?")) {
        Account.cashout({
          strategy: 'ALL'
        })
          .$promise
          .then(function () {
            alert('Cashout Done');
          });
      }
    };

    $scope.getDayPNL = function () {
      $scope.total_pnl = 0;
      $scope.accounts.forEach(function (account, idx) {
        let positionOpen = false;
        $scope.accounts[idx].total = $scope.accounts[idx].positions.reduce(function (total, position) {
          if (position.quantity != 0) positionOpen = true;
          return total + position.m2m;
        }, 0);
        $scope.accounts[idx].totalAbs = Math.abs($scope.accounts[idx].total);
        $scope.total_pnl += $scope.accounts[idx].total;
        $scope.accounts[idx].positionOpen = positionOpen;
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
      ChangeStream.off('positions-update');
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

    $scope.viewPlatform = window.localStorage.getItem('viewPlatform');

    if ($scope.viewPlatform == 'xts') $scope.currentView = 'XTS Only';
    if ($scope.viewPlatform == 'zerodha') $scope.currentView = 'Zerodha Only';

    $scope.getPositions = function () {
      $scope.loadingPositions = true;
      $scope.accounts = [];
      console.log($scope.viewPlatform);
      if ($scope.viewPlatform == 'xts') {
        $scope.loadingDash = true;
        XtsAccount.all_positions_only()
          .$promise.then(function (resp) {
            $scope.accounts = $scope.accounts.concat(resp);
            // $scope.socket = ticker.fn();
            $scope.connectSocket();
            $scope.getDayPNL();
            $scope.loadingDash = false;
          });
      } else if ($scope.viewPlatform == 'zerodha') {
        $scope.loadingDash = true;
        Account.all_positions({
          forceRefresh: $rootScope.liveData
        }).$promise.then(function (resp) {
          $scope.accounts = $scope.accounts.concat(resp);
          // $scope.socket = ticker.fn();
          $scope.connectSocket();
          $scope.getDayPNL();
          $scope.loadingDash = false;
        });
      } else {
        $scope.loadingDash = true;
        Account.all_positions({
          forceRefresh: $rootScope.liveData
        }).$promise.then(function (resp) {
          $scope.accounts = $scope.accounts.concat(resp);
          // $scope.socket = ticker.fn();
          $scope.connectSocket();
          $scope.getDayPNL();
          $scope.loadingDash = false;
        });
        XtsAccount.all_positions_only()
          .$promise.then(function (resp) {
            $scope.accounts = $scope.accounts.concat(resp);
            // $scope.socket = ticker.fn();
            $scope.connectSocket();
            $scope.getDayPNL();
          });
        SparkAccount.all_positions({
          forceRefresh: $rootScope.liveData
        }).$promise.then(function (resp) {
          console.log(resp);
          if (resp && resp.length > 0) {
            $scope.accounts = $scope.accounts.concat(resp);
            // $scope.socket = ticker.fn();
            $scope.connectSocket();
            $scope.getDayPNL();
          }
        });
      }
    }
    $scope.getPositions();

    $scope.roundOff = function (amount) {
      return String(parseInt(amount)).replace(/(\d)(?=(\d\d)+\d$)/g, "$1,")
    }

  })

  .controller("ClientSummaryController", function ($scope, $timeout, $rootScope, Client, ChangeStream, $stateParams) {
    $scope.positions = [];
    $scope.totalM2M = 0;
    $scope.positionInstruments = {};
    $scope.orders = [];
    $scope.loadingPositions = false;
    $scope.loadingOrders = false;
    $scope.strategyPosition = {};

    $scope.tableStyle = {
      fontSize: 16
    };
    if ($rootScope.isMobileDevice()) {
      $scope.tableStyle = {
        fontSize: 14
      };
    }

    $scope.getDayPNL = function () {
      $scope.totalM2M = $scope.positions.reduce(function (s, a) {
        s += a.m2m;
        return s;
      }, 0);
      // $scope.totalM2M = String(parseInt($scope.totalM2M)).replace(/(\d)(?=(\d\d)+\d$)/g, "$1,");
    }

    $scope.connectSocket = function () {
      // // console.log('connecting from main')
      // if ($scope.socket.connected()) {
      //   // console.log('Subscribing');
      //   let allTokens = $scope.positions.map(c => parseInt(c.instrument_token));
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

    $scope.updatePositionsPNL = function (instrument_ltp) {
      $scope.positions.forEach(function (position) {
        if (instrument_ltp[position.instrument_token]) {
          if (position.quantity > 0) {
            position.m2m = ((position.sell_price * position.sell_quantity) + (Math.abs(position.quantity) * instrument_ltp[position.instrument_token])) - (position.buy_price * position.buy_quantity);
          } else if (position.quantity < 0) {
            position.m2m = (position.sell_price * position.sell_quantity) - ((position.buy_price * position.buy_quantity) + (Math.abs(position.quantity) * instrument_ltp[position.instrument_token]));
          }
        }
      });
      $scope.getDayPNL();
    }

    $scope.squareOffbtn = false;
    $scope.squareOff = function () {
      if (confirm('Confirm Square Off Intraday Positions?')) {
        Client.squareOff()
          .$promise
          .then(function (resp) {
            window.location.reload();
          });
      }
    }

    $scope.getPositions = function () {
      $scope.loadingPositions = true;
      Client.day_summary().$promise.then(function (resp) {
        if (resp) {
          $scope.positions = resp.positions;
          $scope.orders = resp.orders.reverse();
          $scope.squareOffbtn = resp.id != 'Paper Trading';
          $scope.strategyPosition = $scope.orders
            .filter(c => $rootScope.liveStrategies.indexOf(c.tag) != -1)
            .reduce((s, a) => {
              s[a.tradingsymbol] = a.tag;
              return s;
            }, {});

          $scope.account_name = resp.name;
          $('[data-toggle="popover"]').popover();
          $scope.loadingPositions = false;
          // $scope.socket = ticker.fn();
          $scope.connectSocket();
          $scope.getDayPNL();
        } else {
          alert('Something went wrong.');
        }
      });
    }
    $scope.getPositions();

    ChangeStream.on('positions-update', function () {
      $scope.getPositions();
    });

    // Cleanup event listeners when controller is destroyed
    $scope.$on('$destroy', function() {
      ChangeStream.off('ticks', $scope.onTicks);
      ChangeStream.off('positions-update');
    });

    $scope.roundOff = function (amount) {
      return String(parseInt(amount)).replace(/(\d)(?=(\d\d)+\d$)/g, "$1,")
    }
  })
  .controller("PositionsController", function ($scope, $state, $timeout, $rootScope, XtsAccount, Account, Positional, PaperTrade, SparkAccount, ChangeStream, StrategyPNL, Orderbook, $stateParams) {
    $scope.positions = [];
    $scope.strategy_positions = [];
    $scope.totalM2M = 0;
    $scope.account_name = $stateParams['name'];
    $rootScope.currentAccountName = $stateParams['name'];
    $scope.full_name = $stateParams['full_name'];
    $scope.platform = $stateParams['platform'];
    $scope.timestamp = $stateParams['ts'] || 0;
    $scope.positionInstruments = {};
    $scope.orders = [];
    $scope.loadingPositions = false;
    $scope.loadingOrders = false;
    $scope.strategyPosition = {};
    $scope.totalOpen = {
      CE: 0,
      PE: 0
    };
    $scope.getLiveOrderbook = false;
    $scope.showOrderbookSettings = false;

    // Retry configuration
    var MAX_RETRIES = 2;
    var RETRY_DELAY = 1500;

    // Helper function for retry logic
    $scope.retryIfEmpty = function(data, retryFn, callback, retryCount, dataName) {
      retryCount = retryCount || 0;
      var isEmpty = !data || (Array.isArray(data) ? data.length === 0 : false);
      
      if (isEmpty && retryCount < MAX_RETRIES) {
        console.log('Empty ' + dataName + ' received, retrying in ' + (RETRY_DELAY/1000) + 's... (attempt ' + (retryCount + 1) + '/' + MAX_RETRIES + ')');
        $timeout(function() {
          retryFn(callback, retryCount + 1);
        }, RETRY_DELAY);
        return true; // Indicates retry scheduled
      }
      return false; // No retry needed
    };

    $scope.analysis = {};
    $scope.showAnalysis = function () {
      XtsAccount.option_analysis({
        accountId: $stateParams['accountId']
      }).$promise.then(function (resp) {
        $scope.analysis = resp.payload;
        // console.log($scope.analysis);
        $('#analysisModal').modal('show');
      });
    }

    if (window.localStorage.getItem('liveOrderbook') == 'true') {
      $scope.getLiveOrderbook = true;
    }

    $scope.toggleOrderbookSource = function () {
      $scope.getLiveOrderbook = !$scope.getLiveOrderbook;
      window.localStorage.setItem('liveOrderbook', $scope.getLiveOrderbook);
    }

    $scope.newOrderWindow = function () {
      $scope.getInstruments();
      $('#newOrderModal').modal('show');
    }

    $scope.sendingOrders = false;
    $scope.submitNewOrder = function () {
      if ($scope.newOrderFrm.tag && $scope.newOrderFrm.tag.length > 0) {
        if (confirm("Confirm Send?")) {
          $scope.sendingOrders = true;
          for (let i = $scope.orderList.length - 1; i >= 0; i--) {
            $scope.orderList[i].tag = $scope.newOrderFrm.tag;
            $scope.redoOrder($scope.orderList[i], function () {
              $scope.orderList.splice(i, 1);
              if ($scope.orderList.length == 0) {
                $scope.sendingOrders = false;
                $('#newOrderModal').modal('hide');
                $scope.getOrders();
                $scope.getPositions();
              }
            });
          }
        }
      } else {
        alert('Order Tag Required.');
      }
    }

    $scope.getInstruments = function () {
      console.log('Loading instruments');
      if (!$scope.instrumentsLoaded) {
        XtsAccount.instruments().$promise.then(function (resp) {
          $scope.instrumentsLoaded = true;
          $scope.tradeableSymbols = resp.instruments;
          console.log('loaded instruments', $scope.tradeableSymbols.length);
        });
      }
    }

    $scope.orderList = [];
    $scope.addToNewOrder = function (instrument) {
      $scope.orderList.push({
        instrument_token: instrument.instrument_token,
        tradingsymbol: instrument.tradingsymbol,
        exchange_token: instrument.exchange_token,
        token: instrument.exchange_token,
        ExchangeInstrumentID: instrument.exchange_token,
        lot_size: parseInt(instrument.lot_size),
        quantity: parseInt(instrument.lot_size),
        transaction_type: 'BUY',
      });
    }
    $scope.removeFromNewOrder = function ($index) {
      $scope.orderList.splice($index, 1);
    }

    $scope.searchInstruments = function () {
      let query = $scope.newOrderFrm.searchSymbol;
      // console.log('search:' + query);
      $scope.searchedSymbols = $scope.tradeableSymbols
        .filter(function (row) {
          return row.tradingsymbol.indexOf(query) != -1;
        }).slice(0, 10);
    }

    $scope.tableStyle = {
      fontSize: 16
    };
    if ($rootScope.isMobileDevice()) {
      $scope.tableStyle = {
        fontSize: 14
      };
    }

    ChangeStream.on('positions-update', function () {
      if ($scope.platform != 'paper'
        && $state.$current.name == 'app.positions'
        && $rootScope.currentAccountName == $scope.account_name
      ) {
        // Preserve current filter state before refreshing
        var currentFilter = $scope.showOrderbookSettings;
        $scope.getPositions(function() {
          // Reapply filter after data refresh
          if (currentFilter) {
            $scope.showStrategyBook(currentFilter);
          }
        });
        $scope.getOrders(function() {
          // Reapply filter after data refresh
          if (currentFilter) {
            $scope.showStrategyBook(currentFilter);
          }
        });
      }
    });


    $scope.manageOrderShow = function () {
      $scope.showManageOrder = !$scope.showManageOrder;
      if ($scope.showManageOrder) {
        $scope.allSelected = null;
        $scope.orders.forEach(function (order) {
          delete order.manage_action;
        });
      }
    }

    $scope.allSelected = false;
    $scope.selectAllOrders = function () {
      $scope.allSelected = !$scope.allSelected;
      $scope.orders.forEach(function (order) {
        if ($scope.allSelected) order.manage_action = true;
        else delete order.manage_action;
      });
    }

    $scope.manageOrders = function (reverse) {
      if (typeof reverse == 'undefined') reverse = false;
      let selectedOrders = $scope.orders.filter(function (order) { return order.manage_action; });
      if (confirm('Confirm send ' + selectedOrders.length + ' orders?')) {
        selectedOrders.forEach(function (order) {
          let newOrder = JSON.parse(JSON.stringify(order));
          if (reverse) {
            newOrder.transaction_type = newOrder.transaction_type == 'BUY' ? 'SELL' : 'BUY';
          }
          $scope.redoOrder(newOrder, function () {
            delete order.manage_action;
          });
        });
      }
    }
    $scope.tranches = (number, chunkSize) => ((new Array(Math.floor(number / chunkSize)).fill(chunkSize).concat(number % chunkSize)).filter(c => c > 0));
    $scope.sqfPositions = function () {
      if (confirm('Confirm SQF Strategy: ' + $scope.selectStrategy + "?")) {
        if ($scope.platform == 'xts') {
          XtsAccount
            .findById({ id: $stateParams['accountId'] })
            .$promise
            .then(function (account) {
              if (!account.bkp_strategy) account.bkp_strategy = {};
              if (typeof account.strategy[$scope.selectStrategy] !== 'undefined' && parseInt(account.strategy[$scope.selectStrategy]) > 0) {
                account.bkp_strategy[$scope.selectStrategy] = parseInt(account.strategy[$scope.selectStrategy]);
                account.strategy[$scope.selectStrategy] = 0;
                account.$save();
              }

              $scope.positions.forEach(function (positions) {
                let direction = positions.quantity > 0 ? 'SELL' : 'BUY';
                if (Math.abs(positions.quantity) > 1200) {
                  $scope.tranches(Math.abs(positions.quantity), 1200).forEach(function (quantity) {
                    XtsAccount.place_order({
                      accountId: $stateParams['accountId'],
                      order: {
                        tag: $scope.selectStrategy,
                        instrumentId: positions.exchange_token,
                        type: direction,
                        quantity: Math.abs(quantity),
                      }
                    });
                  });
                } else {
                  XtsAccount.place_order({
                    accountId: $stateParams['accountId'],
                    order: {
                      tag: $scope.selectStrategy,
                      instrumentId: positions.exchange_token,
                      type: positions.quantity > 0 ? 'SELL' : 'BUY',
                      quantity: Math.abs(positions.quantity),
                    }
                  });
                }
              });
            });
        } else if ($scope.platform == 'zerodha') {
          Account
            .findById({ id: $stateParams['accountId'] })
            .$promise
            .then(function (account) {
              if (!account.bkp_strategy) account.bkp_strategy = {};
              if (typeof account.strategy[$scope.selectStrategy] !== 'undefined' && parseInt(account.strategy[$scope.selectStrategy]) > 0) {
                account.bkp_strategy[$scope.selectStrategy] = parseInt(account.strategy[$scope.selectStrategy]);
                account.strategy[$scope.selectStrategy] = 0;
                account.$save();
              }

              $scope.positions.forEach(function (positions) {
                if (Math.abs(positions.quantity) > 1200) {
                  let direction = positions.quantity > 0 ? 'SELL' : 'BUY';
                  $scope.tranches(Math.abs(positions.quantity), 1200).forEach(function (quantity) {
                    Account.orderFNO({
                      accountId: $stateParams['accountId'],
                      orderOpt: {
                        tradingsymbol: positions.tradingsymbol,
                        transaction_type: direction,
                        order_type: "MARKET",
                        quantity: Math.abs(quantity),
                        trigger_price: 0,
                        price: 0,
                        tag: $scope.selectStrategy
                      }
                    });
                  });
                } else {
                  Account.orderFNO({
                    accountId: $stateParams['accountId'],
                    orderOpt: {
                      tradingsymbol: positions.tradingsymbol,
                      transaction_type: positions.quantity > 0 ? 'SELL' : 'BUY',
                      order_type: "MARKET",
                      quantity: Math.abs(positions.quantity),
                      trigger_price: 0,
                      price: 0,
                      tag: $scope.selectStrategy
                    }
                  });
                }
              });
            });
        }
      }
    }

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

    $scope.calcMargin = function () {
      let ce_lots = Math.abs($scope.totalOpen.CE) / 25;
      let pe_lots = Math.abs($scope.totalOpen.PE) / 25;

      let max_lots = ce_lots > pe_lots ? ce_lots : pe_lots;
      let margin = max_lots * 200000;
      return margin;
    }

    $scope.diff_strategy_pnl = function (data) {
      let strategies = [];
      let strategy_paper = {};
      let order_sequence = [];
      let positionalStrategies = ['CE_D2P_E', 'PE_D2P_E'];

      data.reverse().forEach((order) => {
        if (order.tag.indexOf('|') != -1) order.tag = order.tag.split('|')[0];
        if (order.tag == 'SQF' || order.tag == '') order.tag = 'ADMIN';
        if (!strategy_paper[order.tag]) strategy_paper[order.tag] = [];
        order_sequence.push([order.tag, order.tradingsymbol]);
        strategy_paper[order.tag].push(order);
      });
      strategies = Object.keys(strategy_paper);

      let strategy_positions = {};

      strategies.forEach(function (strategy) {
        if (strategy_paper[strategy] && strategy_paper[strategy].length > 0) {
          strategy_positions[strategy] = {};
          strategy_paper[strategy].forEach((order) => {
            if (order.status.toUpperCase() == 'FILLED' || (order.status.toUpperCase() == 'CANCELLED' && order.CumulativeQuantity > 0 && parseInt(order.average_price) > 0)) {
              order.quantity = order.CumulativeQuantity;
              if (!strategy_positions[strategy][order.tradingsymbol]) {
                strategy_positions[strategy][order.tradingsymbol] = {
                  "tradingsymbol": order.tradingsymbol,
                  "instrument_token": order.instrument_token,
                  "quantity": order.transaction_type.toUpperCase() == 'SELL' ? -1 * order.quantity : order.quantity,
                  "average_price": order.average_price,
                  "last_price": order.average_price,
                  "m2m": 0,
                  "sell_quantity": 0,
                  "sell_price": 0,
                  "sell_value": 0,
                  "buy_quantity": 0,
                  "buy_price": 0,
                  "buy_value": 0,
                };
                strategy_positions[strategy][order.tradingsymbol][(order.transaction_type).toLowerCase() + "_quantity"] = order.quantity;
                strategy_positions[strategy][order.tradingsymbol][(order.transaction_type).toLowerCase() + "_price"] = order.average_price;
                strategy_positions[strategy][order.tradingsymbol][(order.transaction_type).toLowerCase() + "_value"] = order.average_price * order.quantity;
              } else {
                if (order.transaction_type.toUpperCase() == 'SELL') {
                  strategy_positions[strategy][order.tradingsymbol].quantity += -1 * order.quantity;
                  strategy_positions[strategy][order.tradingsymbol].sell_quantity += order.quantity;
                  strategy_positions[strategy][order.tradingsymbol].sell_value += Math.round(order.quantity * order.average_price);
                  strategy_positions[strategy][order.tradingsymbol].sell_price = Math.round(strategy_positions[strategy][order.tradingsymbol].sell_value / strategy_positions[strategy][order.tradingsymbol].sell_quantity * 100) / 100;
                } else {
                  strategy_positions[strategy][order.tradingsymbol].quantity += order.quantity;
                  strategy_positions[strategy][order.tradingsymbol].buy_quantity += order.quantity;
                  strategy_positions[strategy][order.tradingsymbol].buy_value += Math.round(order.quantity * order.average_price);
                  strategy_positions[strategy][order.tradingsymbol].buy_price = Math.round(strategy_positions[strategy][order.tradingsymbol].buy_value / strategy_positions[strategy][order.tradingsymbol].buy_quantity * 100) / 100;
                }
              }

              if (strategy_positions[strategy][order.tradingsymbol].quantity == 0) {
                strategy_positions[strategy][order.tradingsymbol].m2m = strategy_positions[strategy][order.tradingsymbol].sell_value - strategy_positions[strategy][order.tradingsymbol].buy_value;
              }
            }
          });
        }
      });
      // console.log(JSON.parse(JSON.stringify(strategy_positions)));
      // console.log(JSON.parse(JSON.stringify(strategy_positions.ADMIN)));

      order_sequence.forEach(function (sequence) {
        let strategy = sequence[0];
        let position = strategy_positions[strategy][sequence[1]];

        if (strategy != 'ADMIN' && strategy != 'ADMIN' && position) {
          // if (position.tradingsymbol == "BANKNIFTY2181236400CE") console.log(strategy, JSON.parse(JSON.stringify(position)), JSON.parse(JSON.stringify(strategy_positions['ADMIN'][position.tradingsymbol])));
          if (strategy_positions['ADMIN'] && strategy_positions['ADMIN'][position.tradingsymbol] && position.quantity != 0) {
            if (position.quantity + strategy_positions['ADMIN'][position.tradingsymbol].quantity >= 0 && (strategy_positions['ADMIN'][position.tradingsymbol].quantity != 0 && positionalStrategies.indexOf(strategy) == -1)) {
              if (position.quantity > 0) {
                if (strategy_positions['ADMIN'][position.tradingsymbol].sell_price == 0) {
                  strategy_positions['ADMIN'][position.tradingsymbol].sell_price = strategy_positions['ADMIN'][position.tradingsymbol].average_price;
                }
                strategy_positions['ADMIN'][position.tradingsymbol].sell_quantity -= Math.abs(position.quantity);
                strategy_positions['ADMIN'][position.tradingsymbol].sell_value -= Math.abs(position.quantity) * strategy_positions['ADMIN'][position.tradingsymbol].sell_price;
                strategy_positions['ADMIN'][position.tradingsymbol].quantity += Math.abs(position.quantity);
                strategy_positions[strategy][position.tradingsymbol].sell_quantity += Math.abs(position.quantity);
                strategy_positions[strategy][position.tradingsymbol].sell_value += Math.abs(position.quantity) * strategy_positions['ADMIN'][position.tradingsymbol].sell_price;
                strategy_positions[strategy][position.tradingsymbol].sell_price = strategy_positions['ADMIN'][position.tradingsymbol].sell_price;

                strategy_positions[strategy][position.tradingsymbol].quantity -= Math.abs(position.quantity);
              } else {
                if (strategy_positions['ADMIN'][position.tradingsymbol].buy_price == 0) {
                  strategy_positions['ADMIN'][position.tradingsymbol].buy_price = strategy_positions['ADMIN'][position.tradingsymbol].average_price;
                }
                strategy_positions["ADMIN"][position.tradingsymbol].buy_quantity -= Math.abs(position.quantity);
                strategy_positions["ADMIN"][position.tradingsymbol].buy_value -= Math.abs(position.quantity) * strategy_positions['ADMIN'][position.tradingsymbol].buy_price;
                strategy_positions['ADMIN'][position.tradingsymbol].quantity -= Math.abs(position.quantity);
                strategy_positions[strategy][position.tradingsymbol].buy_quantity += Math.abs(position.quantity);
                strategy_positions[strategy][position.tradingsymbol].buy_value += Math.abs(position.quantity) * strategy_positions['ADMIN'][position.tradingsymbol].buy_price;
                strategy_positions[strategy][position.tradingsymbol].buy_price = strategy_positions['ADMIN'][position.tradingsymbol].buy_price;

                strategy_positions[strategy][position.tradingsymbol].quantity += Math.abs(position.quantity);
              }

              strategy_positions[strategy][position.tradingsymbol].m2m = strategy_positions[strategy][position.tradingsymbol].sell_value - strategy_positions[strategy][position.tradingsymbol].buy_value;
            }
          }
        }
      });

      // console.log(strategy_positions);
      // console.log(strategy_positions.ADMIN);
      delete strategy_positions.SQF;
      delete strategy_positions.ADMIN;

      return strategy_positions;
    }

    $scope.allOrders = [];
    $scope.allPositions = [];
    $scope.showStrategyBook = function (strategy) {
      if (strategy == 'ALL') {
        $scope.showOrderbookSettings = false;
        $scope.orders = JSON.parse(JSON.stringify($scope.allOrders));
        $scope.positions = JSON.parse(JSON.stringify($scope.allPositions));
        $scope.getDayPNL();
      } else {
        $scope.showOrderbookSettings = strategy;
        $scope.orders = $scope.allOrders.filter(function (order) {
          var tag = order.tag || '';
          if (tag.indexOf('|') == -1) return tag == strategy;
          else return tag.split('|')[0] == strategy;
        });

        var diff_strategy = $scope.diff_strategy_pnl(JSON.parse(JSON.stringify($scope.allOrders)));
        if (diff_strategy && diff_strategy[strategy]) {
          $scope.fillPositions(Object.values(diff_strategy[strategy]));
        } else {
          console.warn('Strategy not found:', strategy);
          $scope.positions = [];
        }
      }
    }

    $scope.squareOff = function () {
      if (confirm('Are you sure?')) {
        if ($scope.platform == 'zerodha') {
          Account.squareOff({
            accountId: $stateParams['accountId']
          })
            .$promise
            .then(function (resp) {
              alert('SquareOff Done');
            });
        } else if ($scope.platform == 'xts') {
          XtsAccount.squareOff({
            accountId: $stateParams['accountId']
          })
            .$promise
            .then(function (resp) {
              $scope.sync_orderbook();
              alert('SquareOff Done');
            });
        } else if ($scope.platform == 'spark') {
          SparkAccount.squareOff({
            accountId: $stateParams['accountId']
          })
            .$promise
            .then(function (resp) {
              alert('SquareOff Done');
            });
        }
      }
    }

    $scope.redoOrder = function (order) {
      if (confirm('Are you sure?')) {
        if ($scope.platform == 'paper') {
          let new_order = JSON.parse(JSON.stringify(order));
          delete new_order.id;
          PaperTrade
            .create(new_order)
            .$promise
            .then(function () {
              alert('Order Added.');
            });
        } else if ($scope.platform == 'xts') {
          XtsAccount.place_order({
            accountId: $stateParams['accountId'],
            order: {
              tag: order.tag,
              instrumentId: order.ExchangeInstrumentID,
              type: order.transaction_type,
              quantity: order.quantity,
            }
          })
            .$promise
            .then(function (resp) {
              alert('Order Sent!');
            });
        }
      }
    }

    $scope.fillOrders = function (resp, callback, retryCount) {
      // Retry if empty
      if ($scope.retryIfEmpty(resp, $scope.getOrders, callback, retryCount, 'orderbook')) {
        return;
      }
      
      $scope.loadingOrders = false;
      var needsReverse = ['zerodha', 'xts', 'paper', 'positional'].indexOf($scope.platform) !== -1;
      $scope.orders = needsReverse && resp ? resp.reverse() : (resp || []);
      
      $scope.strategyPosition = $scope.orders
        .filter(c => $rootScope.liveStrategies.indexOf(c.tag) != -1 && c.status == 'COMPLETE')
        .reduce((s, a) => {
          s[a.instrument_token] = a.tag;
          return s;
        }, {});
      $('[data-toggle="popover"]').popover();
      
      if (typeof callback === 'function') callback();
    };

    $scope.sync_in_progress = false;
    $scope.sync_orderbook = function () {
      $scope.sync_in_progress = true;
      XtsAccount.sync_orderbook({
        accountId: $stateParams['accountId']
      }).$promise.then(function (orders) {
        $scope.sync_in_progress = false;
        $scope.fillOrders(orders);
        $scope.allOrders = orders.reverse();
        $scope.strategy_positions = $scope.diff_strategy_pnl(orders);
      });
    }
    $scope.backfill_orderbook = function () {
      $scope.sync_in_progress = true;
      XtsAccount.backfill_orderbook({
        accountId: $stateParams['accountId']
      }).$promise.then(function (orders) {
        $scope.sync_in_progress = false;
        $scope.getPositions();
      });
    }

    $scope.getOrders = function (callback, retryCount) {
      if ($stateParams['accountId'] && $stateParams['accountId'].length > 0) {
        $scope.loadingOrders = true;
        if ($scope.platform == 'zerodha') {
          Account.orderbook({
            accountId: $stateParams['accountId']
          }).$promise.then(function(orders) {
            $scope.fillOrders(orders, callback, retryCount);
          });
        } else if ($scope.platform == 'xts' && $scope.getLiveOrderbook) {
          if ($scope.timestamp && $scope.timestamp == 0) {
            XtsAccount.orderbook({
              accountId: $stateParams['accountId']
            }).$promise.then(function (orders) {
              if ($scope.retryIfEmpty(orders, $scope.getOrders, callback, retryCount, 'XTS orderbook')) {
                return;
              }
              $scope.fillOrders(orders, null, retryCount);
              $scope.allOrders = (orders || []).slice().reverse();
              $scope.strategy_positions = $scope.diff_strategy_pnl(orders || []);
              if (typeof callback === 'function') callback();
            });
          }
        } else if ($scope.platform == 'spark') {
          if ($scope.timestamp && $scope.timestamp == 0) {
            SparkAccount.orderbook({
              accountId: $stateParams['accountId']
            }).$promise.then(function(orders) {
              $scope.fillOrders(orders, callback, retryCount);
            });
          }
        }
      }
    }
    $scope.getOrders();

    $scope.getStrategyPNL = function () {
      $scope.strategy_mtm = Object.keys($scope.strategy_positions).map(function (strategy) {
        let strategy_details = {
          title: strategy,
          m2m: 0
        };
        strategy_details.m2m = Object.values($scope.strategy_positions[strategy]).reduce(function (s, a) {
          s += a.m2m;
          return s;
        }, 0);
        return strategy_details;
      });
    }

    $scope.getDayPNL = function () {
      $scope.totalOpen = {
        CE: 0,
        PE: 0
      };
      $scope.strategyTotalM2M = $scope.positions.reduce(function (s, a) {
        if (a.tradingsymbol.indexOf("CE") != -1) $scope.totalOpen['CE'] += a.quantity;
        if (a.tradingsymbol.indexOf("PE") != -1) $scope.totalOpen['PE'] += a.quantity;
        s += a.m2m;
        return s;
      }, 0);
      $scope.totalM2M = $scope.allPositions.reduce(function (s, a) {
        s += a.m2m;
        return s;
      }, 0);

      if ($scope.allPositions.length == 0 && $scope.positions.length != 0) $scope.totalM2M = $scope.strategyTotalM2M;
      // $scope.totalM2M = String(parseInt($scope.totalM2M)).replace(/(\d)(?=(\d\d)+\d$)/g, "$1,");
      if ($scope.chartPnlData && $scope.chartSeries && moment().seconds() % 10 == 0) {
        let currentBar = {
          time: parseInt(moment().utc().add(330, 'minutes').format('X')),
          value: $scope.totalM2M
        }
        $scope.chartPnlData.push(currentBar);
        $scope.chartSeries.update(currentBar);
      }
    }

    $scope.updateStrategyPositionsPNL = function (instrument_ltp) {
      Object.keys($scope.strategy_positions).forEach(function (strategy) {
        Object.values($scope.strategy_positions[strategy]).forEach(function (position) {
          if (instrument_ltp[position.instrument_token]) {
            if (position.quantity > 0) {
              position.m2m = ((position.sell_price * position.sell_quantity) + (Math.abs(position.quantity) * instrument_ltp[position.instrument_token])) - (position.buy_price * position.buy_quantity);
            } else if (position.quantity < 0) {
              position.m2m = (position.sell_price * position.sell_quantity) - ((position.buy_price * position.buy_quantity) + (Math.abs(position.quantity) * instrument_ltp[position.instrument_token]));
            }
          }
        })
      });
      $scope.getStrategyPNL();
    }

    $scope.connectSocket = function () {
      // // console.log('connecting from main')
      // if ($scope.socket.connected()) {
      //   // console.log('Subscribing');
      //   let allTokens = $scope.positions.map(c => parseInt(c.instrument_token));
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
      $scope.updateStrategyPositionsPNL($scope.positionInstruments);
    }
    ChangeStream.on('ticks', $scope.onTicks);

    // Cleanup event listeners when controller is destroyed
    $scope.$on('$destroy', function() {
      ChangeStream.off('ticks', $scope.onTicks);
      ChangeStream.off('positions-update');
      ChangeStream.off('paper-update');
    });

    $scope.updatePositionsPNL = function (instrument_ltp) {
      $scope.positions.forEach(function (position) {
        if (instrument_ltp[position.instrument_token]) {
          if (position.quantity > 0) {
            position.m2m = ((position.sell_price * position.sell_quantity) + (Math.abs(position.quantity) * instrument_ltp[position.instrument_token])) - (position.buy_price * position.buy_quantity);
          } else if (position.quantity < 0) {
            position.m2m = (position.sell_price * position.sell_quantity) - ((position.buy_price * position.buy_quantity) + (Math.abs(position.quantity) * instrument_ltp[position.instrument_token]));
          }
        }
      });
      $scope.getDayPNL();
    }

    $scope.fillPositions = function (resp, callback, retryCount) {
      // Retry if empty
      if ($scope.retryIfEmpty(resp, $scope.getPositions, callback, retryCount, 'positions')) {
        return;
      }
      
      $scope.positions = resp || [];
      $scope.loadingPositions = false;
      $scope.connectSocket();
      $scope.getDayPNL();
      $scope.getStrategyPNL();
      
      if (typeof callback === 'function') callback();
    }

    $scope.checkPaperUpdates = function () {
      ChangeStream.on('paper-update', function (resp) {
        $scope.fillPositions(Object.values(resp.positions[$stateParams['accountId']]));
        resp.orders[$stateParams['accountId']] = resp.orders[$stateParams['accountId']].map(function (order) {
          order.order_timestamp = moment(order.order_timestamp).format();
          return order;
        });
        $scope.fillOrders(resp.orders[$stateParams['accountId']]);
      });
    }

    $scope.saveChart = function () {
      let screenshot = $scope.chart.takeScreenshot();
      screenshot.toBlob(function (blob) {
        saveAs(blob, "chart.png");
      });
    }

    $scope.getPositions = function (callback, retryCount) {
      if ($stateParams['accountId'] && $stateParams['accountId'].length > 0) {
        $scope.loadingPositions = true;
        if ($scope.platform == 'zerodha') {
          Account.positions({
            accountId: $stateParams['accountId']
          }).$promise.then(function(resp) {
            $scope.fillPositions(resp, callback, retryCount);
          });
        } else if ($scope.platform == 'xts') {
          if ($scope.timestamp && $scope.timestamp != 0) {
            console.log('check');
            Orderbook.findOne({
              filter: {
                where: {
                  name: $stateParams['accountId'],
                  createdAt: moment($scope.timestamp, 'X').utcOffset(0).hour(0).minute(0).format().substr(0, 19) + 'Z'
                }
              }
            }).$promise.then(function (resp) {
              $scope.fillPositions(Object.values(resp.positions), callback, retryCount);
              $scope.fillOrders(resp.orders);
              $scope.strategy_positions = $scope.diff_strategy_pnl(resp.orders);
            })
          } else if ($scope.getLiveOrderbook) {
            XtsAccount.positions({
              accountId: $stateParams['accountId']
            }).$promise.then(function (resp) {
              if ($scope.retryIfEmpty(resp, $scope.getPositions, callback, retryCount, 'XTS positions')) {
                return;
              }
              $scope.fillPositions(resp, callback, retryCount);
              $scope.allPositions = resp || [];
            });
          } else if (!$scope.getLiveOrderbook) {
            XtsAccount.position2({
              accountId: $stateParams['accountId']
            }).$promise.then(function (resp) {
              var positions = resp && resp.position;
              if ($scope.retryIfEmpty(positions, $scope.getPositions, callback, retryCount, 'XTS position2')) {
                return;
              }
              $scope.fillPositions(positions, callback, retryCount);
              $scope.allPositions = positions || [];
              $scope.fillOrders(resp.orders);
              $scope.allOrders = (resp.orders || []).slice().reverse();
              $scope.strategy_positions = $scope.diff_strategy_pnl(resp.orders || []);
            });
          }
        } else if ($scope.platform == 'spark') {
          SparkAccount.positions({
            accountId: $stateParams['accountId']
          }).$promise.then(function(resp) {
            $scope.fillPositions(resp, callback, retryCount);
          });
        } else if ($scope.platform == 'paper') {
          let filter = {};
          if ($scope.timestamp && $scope.timestamp != 0) {
            filter.ts = parseInt($scope.timestamp);
          }
          PaperTrade.positions(filter).$promise.then(function (resp) {
            $scope.fillPositions(Object.values(resp.positions[$stateParams['accountId']]));
            resp.orders[$stateParams['accountId']] = resp.orders[$stateParams['accountId']].map(function (order) {
              order.order_timestamp = moment(order.order_timestamp).format();
              return order;
            });
            $scope.fillOrders(resp.orders[$stateParams['accountId']]);
            strategyData = resp.orders[$stateParams['accountId']];
            if ($scope.timestamp && $scope.timestamp == 0) {
              $scope.checkPaperUpdates();
            }
            console.log(resp.ts);
            let todayStart = moment(resp.ts).startOf('day').toDate();
            let todayEnd = moment(resp.ts).endOf('day').toDate();
            // if ($rootScope.superadmin) {
            //   $scope.getOHLCGraph();
            // } else {
            StrategyPNL.find({
              filter: {
                where: {
                  strategy: $stateParams['accountId'],
                  ts: {
                    between: [
                      todayStart.toISOString(),
                      todayEnd.toISOString()
                    ]
                  }
                },
                fields: {
                  open: 1,
                  m2m: 1,
                  ts: 1
                }
              }
            }).$promise.then(function (resp) {
              // console.log(resp);
              $scope.drawChart(resp);
            });
            // }
          });
        } else if ($scope.platform == 'positional') {
          let filter = {};
          if ($scope.timestamp && $scope.timestamp != 0) {
            filter.ts = parseInt($scope.timestamp);
          }
          Positional.positions(filter).$promise.then(function (resp) {
            $scope.fillPositions(Object.values(resp.positions[$stateParams['accountId']]));
            resp.orders[$stateParams['accountId']] = resp.orders[$stateParams['accountId']].map(function (order) {
              order.order_timestamp = moment(order.order_timestamp).format();
              return order;
            });
            $scope.fillOrders(resp.orders[$stateParams['accountId']]);
            strategyData = resp.orders[$stateParams['accountId']];
          });
        }
      }
    }
    $scope.getPositions();

    $scope.chartPnlData = [];
    $scope.drawChart = function (rawdata) {
      $scope.chartPnlData = rawdata.map(c => ({
        time: parseInt(moment(c.ts).add(330, 'minute').format('X')),
        value: c.m2m
      }));

      var container = document.getElementById('pnl_chart');
      container.innerHTML = '';
      var width = container.clientWidth;
      var height = 400;
      $scope.chart = LightweightCharts.createChart(container, {
        width: width,
        height: height,
        timeScale: {
          timeVisible: true,
          secondsVisible: true,
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
            visible: true,
            labelVisible: true
          },
          vertLine: {
            visible: true,
            sabelVisible: true,
          }
        },
      });

      $scope.chartSeries = $scope.chart.addAreaSeries({
        topColor: 'rgba(19, 68, 193, 0.4)',
        bottomColor: 'rgba(0, 120, 255, 0.0)',
        lineColor: 'rgba(19, 40, 153, 1.0)',
        lineWidth: 3,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
        priceScaleId: 'right',
        scaleMargins: {
          top: 0.2,
          bottom: 0.05,
        },
        priceFormat: {
          type: 'price',
          precision: 0,
          minMove: 1,
        }
      });
      $scope.chartSeries.setData($scope.chartPnlData);
      $scope.chart.timeScale().fitContent();
    }
    $scope.drawChartOHLC = function (rawdata) {
      $scope.chart_series1 = rawdata.filter(c => c.supertrend).map(c => ({
        time: parseInt(moment(c.ts).add(330, 'minute').format('X')),
        value: c.supertrend
      }));
      $scope.chart_series2 = rawdata.map(c => ({
        time: parseInt(moment(c.ts).add(330, 'minute').format('X')),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));

      var container = document.getElementById('pnl_chart');
      container.innerHTML = '';
      var width = container.clientWidth;
      var height = 400;
      $scope.chart = LightweightCharts.createChart(container, {
        width: width,
        height: height,
        timeScale: {
          timeVisible: true,
          secondsVisible: true,
          borderVisible: false,
        },
        grid: {
          horzLines: {
            color: '#fff',
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
            visible: false,
            sabelVisible: false,
          }
        },
      });

      $scope.chartSeries = $scope.chart.addAreaSeries({
        topColor: 'rgba(19, 68, 193, 0)',
        bottomColor: 'rgba(0, 120, 255, 0)',
        lineColor: 'rgba(0, 0, 0, 1.0)',
        lineWidth: 1,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
        priceScaleId: 'right',
        scaleMargins: {
          top: 0.2,
          bottom: 0.05,
        },
        priceFormat: {
          type: 'price',
          precision: 0,
          minMove: 1,
        }
      });
      $scope.chartCandleSeries = $scope.chart.addCandlestickSeries();
      $scope.chartSeries.setData($scope.chart_series1);
      $scope.chartCandleSeries.setData($scope.chart_series2);
      chart.timeScale().fitContent();
    }

    $scope.roundOff = function (amount) {
      return String(parseInt(amount)).replace(/(\d)(?=(\d\d)+\d$)/g, "$1,")
    }
  })

  .controller("ScreenerController", function ($scope, $window, $timeout, $rootScope, Instrument) {
    $scope.instruments = [];
    $scope.searchStock = {};
    $scope.instrumentToken = {};
    $scope.tableStyle = {
      fontSize: 16
    };
    if ($rootScope.isMobileDevice()) {
      $scope.tableStyle = {
        fontSize: 14
      };
    }
    $scope.liveConnected = true;

    $scope.getSignal = function (s) {
      if ($rootScope.tickerConnected) return s ? 'BUY' : 'SELL';
      else return '-';
    }

    fetch('/data/marketwatch.json?cache=' + (new Date()).getTime()).then(function (resp) {
      return resp.json();
    }).then(function (data) {
      $scope.instruments = data.sort(function (a, b) {
        return a.position - b.position;
      }).map(function (stock, idx) {
        $scope.instrumentToken[stock.instrument_token] = idx;
        return stock;
      });

      $timeout(function () {
        $rootScope.$emit('refreshFixedColumns');
      }, 2500);
      // console.log($scope.instruments);
      // $scope.socket = ticker.fn();
      $scope.connectSocket();
    });

    $scope.connectSocket = function () {
      // if ($scope.socket.connected()) {
      //   // console.log('Subscribing');
      //   let allTokens = Object.keys($scope.instrumentToken).map(c => parseInt(c));
      //   $scope.socket.subscribe(allTokens);
      //   $scope.socket.setMode('full', allTokens);
      //   $rootScope.ticker.on("ticks", $scope.onTicks);

      // } else {
      //   $scope.socket = ticker.fn();
      //   // console.log('not connected');
      //   $timeout($scope.connectSocket, 1000);
      // }
    }

    $scope.onTicks = function (ticks) {
      ticks.forEach(tick => {
        if ($scope.instruments[$scope.instrumentToken[tick.instrument_token]]) {
          $scope.instruments[$scope.instrumentToken[tick.instrument_token]].tick = tick;
          $scope.instruments[$scope.instrumentToken[tick.instrument_token]].last_price = tick.last_price;
          $scope.$apply();
        }
      });
    }

    $scope.netChange = function (price, len) {
      return price.toFixed(len);
    }
  })

  .controller("LoginController", function ($scope, $state, Client, ChangeStream) {
    if (Client.isAuthenticated()) {
      if (window.localStorage.getItem('superadmin')) {
        $state.go("app.papertrading");
      } else $state.go("app.papertrading");
    }

    $scope.count = function (c, len, target) {
      if (String($scope[c]).length == len) {
        if (target == '#loginButton') $scope.login();
        else $(target).focus();
      }
    }

    $scope.login = function () {
      Client.login({
        username: String($scope.username),
        password: String($scope.password)
      },
        function (clientDetails) {
          console.log("logged in", clientDetails);
          ChangeStream.start();
          if (clientDetails.user.superadmin) {
            $state.go("app.papertrading");
            window.localStorage.setItem('superadmin', true);
            if (clientDetails.user.viewPlatform) window.localStorage.setItem('viewPlatform', clientDetails.user.viewPlatform);
            else window.localStorage.removeItem('viewPlatform');
          } else $state.go("app.papertrading");
        },
        function (error) {
          console.log(error);
          alert('Kindly check your mobile and passcode.');
        }
      );
    };

    $scope.register = function () {
      if (String($scope.username).length == 10) {
        if (String($scope.name).length > 5) {
          Client.create({
            fullname: String($scope.name),
            username: String($scope.username),
            password: String($scope.password),
            createdAt: (new Date()).getTime()
          },
            function () {
              $scope.login();
            },
            function (error) {
              if (error.data.error.message.indexOf('User already exists') != -1) {
                alert('Your account already exists. Try logging in OR Contact support@algomaker.in for PIN reset.');
              } else alert(error.data.error.message);
            }
          );
        } else alert('Name should be above 5characters.');
      } else alert('Mobile no should be 10digit.');
    };

  })

  .directive('fullSize', ['$document', function ($document) {
    return {
      link: function (scope, element, attr) {
        element.css({
          height: window.innerHeight + 'px',
        });
      }
    };
  }]);
