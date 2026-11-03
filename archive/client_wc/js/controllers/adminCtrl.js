angular
  .module("app")

  .controller("ReportsController", function ($scope, $rootScope, $interval, $state, $timeout, Report, XtsAccount, Client, Orderbook, PaperTrade, Account) {
    $scope.strategies = $rootScope.liveStrategies;
    // let paperStrategies = ['Akbar_AI', 'Spider', 'F2', 'Scalper', 'S3', 'R1', 'R2', 'R4', 'X1', 'X2'];
    // $scope.strategies = $scope.strategies.concat(paperStrategies);
    $scope.strategies = Array.from(new Set($scope.strategies));
    $scope.accounts = [];
    $scope.dateEnd = moment().add(1, 'day').toDate();
    $scope.dateStart = moment().subtract(1, 'year').toDate();
    $scope.viewForm = true;
    $scope.hasOrders = false;
    $scope.reportColSpan = 3;
    $scope.tradebook_type = false;
    $scope.clientCode = '';
    $scope.win_days = 0;
    $scope.loss_days = 0;

    $scope.win_amount = 0;
    $scope.loss_amount = 0;

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
            $scope.getData();
          } else {
            $scope.accountAdded = false;
          }
        });
    }
    $scope.getAccount();

    $scope.saveDoc = function () {
      var htmlSource = document.querySelector('#reportsContainer');
      html2canvas(htmlSource, {
        logging: false,
        background: '#FFFFFF',
        scale: 3,
        windowWidth: htmlSource.scrollWidth,
        windowHeight: htmlSource.scrollHeight,
        onrendered: function (canvas) {
          var a = document.createElement("a");
          a.href = canvas.toDataURL("image/png");
          a.download = $scope.clientCode + "_report.png";
          a.click();
        }
      });
    }

    $scope.getAllTradesClient = function () {
      let dateStart = moment($scope.dateStart).startOf('day').toDate();
      let dateEnd = moment($scope.dateEnd).endOf('day').toDate();
      Orderbook.find({
        filter: {
          where: {
            name: $scope.clientCode,
            createdAt: {
              between: [dateStart, dateEnd]
            }
          }
        }
      }).$promise.then(function (trades) {
        if (trades.length > 0) {
          $scope.hasOrders = true;
          $scope.reportColSpan = 4;
          $scope.tradebook_type = 'client';
        } else {
          $scope.hasOrders = false;
          $scope.reportColSpan = 3;
          $scope.tradebook_type = false;
        }
        $scope.trades = trades.reduce(function (orders, daybook) {
          orders = orders.concat(daybook.orders);
          return orders;
        }, []);
        $scope.reports.forEach($scope.getTrades);
      });
    }

    $scope.getAllTrades = function () {
      let dateStart = moment($scope.dateStart).startOf('day').toDate();
      let dateEnd = moment($scope.dateEnd).endOf('day').toDate();
      PaperTrade.find({
        filter: {
          where: {
            tag: $scope.clientCode,
            order_timestamp: {
              between: [dateStart, dateEnd]
            }
          }
        }
      }).$promise.then(function (trades) {
        if (trades.length > 0) {
          $scope.hasOrders = true;
          $scope.reportColSpan = 4;
          $scope.tradebook_type = 'paper';
        } else {
          $scope.hasOrders = false;
          $scope.reportColSpan = 3;
          $scope.tradebook_type = false;
        }
        $scope.trades = trades;
        $scope.reports.forEach($scope.getTrades);
      });
    }

    $scope.getTrades = function (day_summary, idx) {
      let dayTs = $scope.reports[idx].x;
      let dateStart = moment(dayTs).startOf('day');
      let dateEnd = moment(dayTs).endOf('day');
      $scope.reports[idx].trades = $scope.trades.filter(function (trade) {
        return moment(trade.order_timestamp).isBetween(dateStart, dateEnd);
      });
    }

    $scope.parseTs = function (ts) {
      return moment(ts).utcOffset("+05:30").format('HH:mm:ss');
    }

    $scope.getAccounts = function () {
      $scope.accounts = [];
      XtsAccount
        .find()
        .$promise
        .then(function (accounts) {
          $scope.accounts = $scope.accounts.concat(accounts);
        });
      Account
        .find()
        .$promise
        .then(function (accounts) {
          accounts = accounts.sort(function (a, b) {
            try {
              return b.margins.equity.net - a.margins.equity.net;
            } catch (err) {
              return 0;
            }
          });
          $scope.accounts = $scope.accounts.concat(accounts);
        });
    }
    $timeout(function () {
      if ($rootScope.superadmin && $rootScope.execRights) $scope.getAccounts();
    }, 1000);

    $scope.reports = [];
    $scope.totalPnl = 0;
    $scope.getData = function () {
      let query = {};
      if ($rootScope.superadmin) {
        query.clientCode = $scope.clientCode;
      } else if (!$rootScope.superadmin && $scope.accountAdded) {
        query.clientCode = $scope.account.name;
      } else {
        alert('No Account Mapped');
      }
      console.log('Fetching report for :' + $scope.clientCode + ':');
      console.log('Accounts:', $scope.accounts);
      // Determine tradebook type based on clientCode
      for (let i = 0; i < $scope.accounts.length; i++) {
        if ($scope.accounts[i].name === $scope.clientCode.trim()) {
          $scope.tradebook_type = 'client';
          break;
        }
      }

      if ($scope.strategy) {
        query.strategy = $scope.strategy;
      }

      if (query.clientCode) {
        query.ts = {
          between: [
            $scope.dateStart,
            $scope.dateEnd
          ]
        };

        Report.find({
          filter: {
            where: query,
            order: 'ts asc'
          }
        }).$promise.then(function (resp) {
          // $scope.reports = resp;
          $scope.viewForm = false;
          $scope.win_days = 0;
          $scope.loss_days = 0;

          $scope.win_amount = 0;
          $scope.loss_amount = 0;

          resp = resp.reduce(function (summary, row) {
            if (!summary[$rootScope.parseDate(row.ts)]) summary[$rootScope.parseDate(row.ts)] = 0;
            summary[$rootScope.parseDate(row.ts)] += row.pnl;
            return summary;
          }, {});
          let pnlCummulative = 0;
          $scope.reports = Object.keys(resp).map(function (dt) {
            pnlCummulative += resp[dt];
            if (resp[dt] > 0) {
              $scope.win_days += 1;
              $scope.win_amount += resp[dt];
            } else if (resp[dt] < 0) {
              $scope.loss_days += 1;
              $scope.loss_amount += resp[dt];
            }
            return {
              ts: parseInt(moment(dt).add(1, 'day').utcOffset(0).minute(0).hour(0).format('X')),
              x: dt,
              y: resp[dt],
              c: pnlCummulative
            };
          });
          $scope.totalPnl = pnlCummulative;
          $scope.drawChart($scope.reports);
          // if ($scope.strategies.indexOf($scope.clientCode) != -1) $scope.getAllTrades();
          // else $scope.getAllTradesClient();
        });
      }
    }

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
  .controller("UsersController", function ($scope, $rootScope, $interval, $state, $timeout, ticker, Client, Account) {
    $scope.accounts = [];
    $scope.users = [];

    $scope.delUser = function (id) {
      if (confirm("Are you sure you want to delete")) {
        Client.destroyById({
          id: id
        }).$promise.then(function (resp) {
          alert('Account Deleted!');
        });
      }
    }

    $scope.resetPin = function (user) {
      Client.resetPin({
        clientId: user.id
      }).$promise.then(function (resp) {
        alert('Pin Changed Successfully.');
      })
    }

    $scope.upMapAccount = function (accountId) {
      if (confirm('Confirm remove account from user?')) {
        Account.prototype$updateAttributes({
          id: accountId
        }, {
          clientId: null
        }).$promise.then(function (resp) {
          alert('Account Un-Mapped');
        });
      }
    }

    $scope.mapAccount = function (userId) {
      let clientCode = prompt('Enter Client Code?', '');
      if (clientCode && String(clientCode).length == 6) {
        clientCode = clientCode.toUpperCase();
        let clientIdx = $scope.accounts.findIndex(function (client) {
          return client.name.toUpperCase() == clientCode;
        });
        if (clientIdx != -1 && confirm('Confirm Map?')) {
          let account = $scope.accounts[clientIdx];
          Account.prototype$updateAttributes({
            id: account.id
          }, {
            clientId: userId
          }).$promise.then(function (resp) {
            alert('Account Mapped');
          });
        } else {
          alert('Account not found.');
        }
      }
    }

    $scope.getAccountsData = function () {
      Account.find()
        .$promise
        .then(function (accounts) {
          $scope.accounts = accounts;
        })
    }
    $scope.getAccountsData();
    $scope.getUsersData = function () {
      Client.find({
        filter: {
          include: 'accounts'
        }
      })
        .$promise
        .then(function (users) {
          $scope.users = users;
        })
    }
    $scope.getUsersData();
  })
  .controller("AccountsController", function ($scope, $rootScope, $interval, $state, $timeout, ticker, Client, SparkAccount, XtsAccount, Tmp_account, Account) {
    $scope.accounts = [];
    $scope.xtsAccounts = [];
    $scope.SparkAccounts = [];
    $scope.account = {};
    $scope.totalMargin = 0;

    $scope.updateName = function (account) {
      let newName = prompt('New Name? ', account.username);
      if (newName && confirm('Confirm Change Name?')) {
        account.username = newName;
        account.$save();
      }
    }

    $scope.loadMargins = function () {
      Account.loadMargins()
        .$promise
        .then($scope.getData());
      XtsAccount.allMargins()
        .$promise
        .then($scope.getXtsData());
    }

    $scope.delXtsAccount = function (id) {
      if (confirm('Confirm Delete ?')) {
        XtsAccount.destroyById({
          id: id
        })
          .$promise
          .then(function (res) {
            let idx = $scope.xtsAccounts.findIndex(function (account) {
              return account.id == id;
            });
            if (idx != -1) delete $scope.xtsAccounts[idx];
            alert('Account Deleted!');
          });
      }
    }
    $scope.delSparkAccount = function (id) {
      if (confirm('Confirm Delete ?')) {
        SparkAccount.destroyById({
          id: id
        })
          .$promise
          .then(function (res) {
            let idx = $scope.SparkAccounts.findIndex(function (account) {
              return account.id == id;
            });
            if (idx != -1) delete $scope.SparkAccounts[idx];
            alert('Account Deleted!');
          });
      }
    }

    $scope.delAccount = function (id) {
      let idx = $scope.accounts.findIndex(function (account) {
        return account.id == id;
      });
      if (idx != -1 && confirm('Confirm Delete ?')) {
        Account.removeAccount({
          accountId: id
        })
          .$promise
          .then(function (res) {
            if (idx != -1) delete $scope.accounts[idx];
            alert('Account Deleted!');
          });
      }
    }
    $scope.delTmpAccount = function (id) {
      if (confirm('Confirm Delete ?')) {
        Tmp_account.destroyById({
          id: id
        })
          .$promise
          .then(function (res) {
            let idx = $scope.tmp_accounts.findIndex(function (account) {
              return account.id == id;
            });
            if (idx != -1) delete $scope.tmp_accounts[idx];
            alert('Account Deleted!');
          });
      }
    }

    $scope.getSparkData = function () {
      SparkAccount.find()
        .$promise
        .then(function (accounts) {
          $scope.SparkAccounts = accounts;
          $scope.total_margin = 0;
          $scope.SparkAccounts.forEach(function (account) {
            if (account.margin) {
              $scope.total_margin += parseInt(account.margin);
            }
          });
        })
    }
    $scope.getSparkData();

    $scope.getXtsData = function () {
      XtsAccount.find()
        .$promise
        .then(function (accounts) {
          $scope.xtsAccounts = accounts;
          $scope.total_margin = 0;
          $scope.xtsAccounts.forEach(function (account) {
            if (account.margin) {
              $scope.total_margin += parseInt(account.margin);
            }
          });
        })
    }
    $scope.getXtsData();
    $scope.getData = function () {
      Account.find()
        .$promise
        .then(function (accounts) {
          $scope.accounts = accounts;
          $scope.totalMargin = accounts.reduce(function (total, acc) {
            if (acc.margins && acc.margins.equity) total += acc.margins.equity.net;
            return total;
          }, 0);
        })
    }
    $scope.getData();

    $scope.getTmpAccount = function () {
      Tmp_account.find()
        .$promise
        .then(function (accounts) {
          $scope.tmp_accounts = accounts;
        });
    }
    $scope.getTmpAccount();

    $scope.newDuckAccount = function () {
      $scope.account = {
        name: '',
        username: '',
        broker: '',
        credentials: {
          user_id: '',
          password: '',
          twofa: '',
        },
        config: {},
        margins: "0"
      };
      $('#addSparkAccount').modal('show');
    }
    $scope.newXtsAccount = function () {
      $scope.account = {
        name: '',
        username: '',
        broker: '',
        credentials: {
          appKey: '',
          secretKey: '',
          url: 'http://mtrade.arhamshare.com:3000/interactive'
        },
        config: {},
        margins: {}
      };
      $('#addXtsAccount').modal('show');
    }
    $scope.newAccount = function () {
      $scope.account = {
        username: '',
        credentials: {},
        broker: 'zerodha',
        config: {},
        margins: {}
      };
      $('#addAccount').modal('show');
    }

    $scope.RetryAccount = function (account) {
      $scope.account = account;
      let deleteAcc = $scope.account.id;
      delete $scope.account.id;
      $scope.saveAccount(function () {
        Tmp_account.destroyById({
          id: deleteAcc
        })
          .$promise
          .then(function (res) {
            let idx = $scope.tmp_accounts.findIndex(function (account) {
              return account.id == deleteAcc;
            });
            if (idx != -1) delete $scope.tmp_accounts[idx];
          });
      });
    }

    $scope.saveAccount = function (cb) {
      $scope.account.name = $scope.account.credentials.user_id;
      Account.check({
        account: $scope.account
      })
        .$promise
        .then(function (resp) {
          if (resp.status) {
            if ($scope.account.username == '') {
              $scope.account.username = resp.profile.data.user_name;
            }
            $scope.account.config = resp.profile;
            $scope.account.margins = resp.margins;
            Account.create($scope.account)
              .$promise
              .then(function (resp) {
                $scope.accounts.push($scope.account);
                $('#addAccount').modal('hide');
                alert('Account Added.');
                if (typeof cb == 'function') cb();
              }).catch(function (err) {
                alert(err.data.error.message);
              });
          } else alert(resp.message);
        });
    }

    $scope.saveSparkAccount = function () {
      SparkAccount.check({
        account: $scope.account
      })
        .$promise
        .then(function (resp) {
          if (resp.status) {
            if ($scope.account.name == '') {
              $scope.account.name = $scope.account.credentials.user_id;
            }
            SparkAccount.create($scope.account)
              .$promise
              .then(function (resp) {
                $scope.SparkAccounts.push($scope.account);
                $('#addSparkAccount').modal('hide');
              }).catch(function (err) {
                alert(err.data.error.message);
              });
          } else alert(resp.message);
        });
    }

    $scope.saveXtsAccount = function () {
      XtsAccount.check({
        account: $scope.account
      })
        .$promise
        .then(function (resp) {
          if (resp.status) {
            if ($scope.account.name == '') {
              $scope.account.name = resp.userId;
            }
            XtsAccount.create($scope.account)
              .$promise
              .then(function (resp) {
                $scope.xtsAccounts.push($scope.account);
                $('#addXtsAccount').modal('hide');
              }).catch(function (err) {
                alert(err.data.error.message);
              });
          } else alert(resp.message);
        });
    }
  })
  .controller("AllOrdersController", function ($scope, $rootScope, $interval, $state, $timeout, ticker, Client, Account, XtsAccount) {
    $scope.accounts = [];
    $scope.total_pnl = 0;
    $scope.positionInstruments = {};
    $scope.loadingPositions = false;

    $scope.getPositions = function () {
      $scope.loadingPositions = true;
      XtsAccount.all_positions({
        forceRefresh: true
      }).$promise.then(function (resp) {
        $scope.accounts = resp;
        $scope.loadingPositions = false;
        $scope.orders = $scope.accounts.reduce(function (orders, account) {
          account.orders = account.orders.map(function (orders2) {
            orders2.account = {
              platform: account.platform,
              name: account.name,
              accountId: account.accountId,
              full_name: account.fullname,
            };
            return orders2;
          })
          return orders.concat(account.orders);
        }, []).sort(function (a, b) {
          return moment(b.order_timestamp, 'DD-MM-YYYY HH:mm:ss').diff(moment(a.order_timestamp, 'DD-MM-YYYY HH:mm:ss'));
        });
      });
    }
    $scope.getPositions();

    $scope.roundOff = function (amount) {
      return String(parseInt(amount)).replace(/(\d)(?=(\d\d)+\d$)/g, "$1,")
    }
  })
  .controller("StrategyController", function ($scope, $rootScope, $interval, $state, $timeout, ticker, Positional, Client, Manager, SparkAccount, XtsAccount, Account) {
    $scope.accounts = [];
    $scope.total_pnl = 0;
    $scope.totalMargin = 0;
    $scope.editLots = false;
    $scope.showAdvanced = false;

    $scope.editLotsToggle = function () {
      $scope.editLots = !$scope.editLots;
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
    $scope.shortName = function (name) {
      return name.substr(0, 10);
    }
    $scope.positionInstruments = {};
    $scope.loadingPositions = false;
    $scope.liveStrategies = Array.from(new Set($rootScope.liveStrategies));
    $scope.show_strategies = {};
    $scope.totalLots = {};
    $scope.grandtotalLots = 0;

    $scope.getAccounts = function () {
      Account.find()
        .$promise
        .then(function (accounts) {
          $scope.margins = accounts;
          $scope.totalMargin = 0;
          $scope.margins = $scope.margins.reduce(function (margins, client) {
            margins[client.name] = client.margins;
            if (client.margins && client.margins.equity.net) $scope.totalMargin += client.margins.equity.net;
            return margins;
          }, {});
        })
    }
    $scope.getAccounts();

    $scope.manageStrategies = {};
    $scope.getRunning = function () {
      Manager.list().$promise.then(function (resp) {
        $scope.manageStrategies = resp.reduce(function (s, a) {
          s[a.name] = a.module;
          return s;
        }, {});
      });
    }
    $scope.getRunning();

    $scope.addStrategy = function () {
      $scope.newStrategy = {};
      $('#addXtsStrategy').modal('show');
    }

    $scope.addNewStrategy = function () {
      var newName = prompt("Enter new strategy name:");
      if (newName && newName.trim() !== "") {
        if ($scope.liveStrategies.indexOf(newName) === -1) {
          $scope.liveStrategies.push(newName);
          $scope.show_strategies[newName] = true;
          $scope.newStrategy.strategy = newName;
        } else {
          alert("Strategy already exists!");
        }
      }
    };

    $scope.isStrategyAdded = function (strategy) {
      if ($scope.liveStrategies.indexOf(strategy) != -1) {
        $scope.liveStrategies.push(strategy);
      }
    }

    $scope.positionalStrategies = $rootScope.positionalStrategies;
    $scope.postSquareOff = function (account) {
      $scope.updateBkpLotSizeXts(account, account.qty);
      if (account.platform == 'xts') {
        XtsAccount.removePending({
          accountId: account.accountId,
          strategy: account.strategy
        });
      }
      Manager.stop({
        name: $scope.manageStrategies[account.strategy]
      });
      alert('Square off Done');
      account.qty = 0;
      $scope.updateLotSizeXts(account);
    }
    $scope.squareOff = function (account) {
      if (confirm("Confirm Square Off " + account.strategy + "?")) {
        if ($scope.positionalStrategies.indexOf(account.strategy) != -1) {
          Positional.squareoff({
            strategy: account.strategy,
          }).$promise.then(function () {
            $scope.postSquareOff(account);
          })
        } else {
          Account.cashout({
            strategy: account.strategy
          }).$promise.then(function () {
            $scope.postSquareOff(account);
          });
        }
      }
    }

    $scope.runningStrategies = [];
    // $scope.loaded = false;
    $scope.getPositions = function () {
      $scope.loadingPositions = true;
      // $scope.loaded = true;
      $scope.accounts = [];
      $scope.runningStrategies = [];
      $scope.grandtotalLots = 0;
      XtsAccount.find()
        .$promise
        .then(function (xtsResp) {
          xtsResp.forEach(function (row) {
            row.broker = 'xts';
          });
          $scope.accounts = $scope.accounts.concat(xtsResp);

          SparkAccount.find()
            .$promise
            .then(function (sparkResp) {
              sparkResp.forEach(function (row) {
                row.broker = 'spark';
              });
              $scope.accounts = $scope.accounts.concat(sparkResp);

              $scope.loadingPositions = false;
              $scope.accounts.forEach(function (account) {
                Object.keys(account.strategy).forEach(function (strategy) {
                  $scope.isStrategyAdded(strategy);
                  if (account.strategy[strategy] && parseInt(account.strategy[strategy]) > 0) {
                    $scope.runningStrategies.push({
                      accountId: account.id,
                      name: account.name,
                      fullname: account.name,
                      platform: account.broker,
                      strategy: strategy,
                      target: account.target || 0,
                      qty: account.strategy[strategy]
                    })
                  }
                  if (!$scope.totalLots[strategy]) $scope.totalLots[strategy] = 0;
                  $scope.totalLots[strategy] += parseInt(account.strategy[strategy]) ? parseInt(account.strategy[strategy]) : 0;
                  if ($scope.totalLots[strategy] > 0) $scope.show_strategies[strategy] = true;
                  $scope.grandtotalLots += parseInt(account.strategy[strategy]) ? parseInt(account.strategy[strategy]) : 0;
                });
              });

            });
        });
    }
    $scope.getPositions();

    $scope.updateTarget = function (account) {
      account.target = parseInt(account.target);
      if (typeof account.target == 'number') {
        XtsAccount.prototype$updateAttributes({
          id: account.accountId
        }, {
          target: account.target
        }).$promise.then(function (resp) {
          $scope.getPositions();
        });
      }
    }
    $scope.saveXtsStrategy = function () {
      let full_account = $scope.accounts.filter(function (a) {
        return a.id == $scope.newStrategy.accountId;
      });
      if (full_account.length > 0) full_account = full_account[0];
      console.log(full_account, $scope.newStrategy);
      full_account.strategy[$scope.newStrategy.strategy] = parseInt($scope.newStrategy.quantity);

      if (full_account.broker == 'xts') {
        XtsAccount.prototype$updateAttributes({
          id: full_account.id
        }, {
          strategy: full_account.strategy
        }).$promise.then(function (resp) {
          $('#addXtsStrategy').modal('hide');
          $scope.getPositions();
        });
      } else {
        SparkAccount.prototype$updateAttributes({
          id: full_account.id
        }, {
          strategy: full_account.strategy
        }).$promise.then(function (resp) {
          $('#addXtsStrategy').modal('hide');
          $scope.getPositions();
        });
      }
    }
    $scope.updateLotSizeXts = function (account) {
      let full_account = $scope.accounts.filter(function (a) {
        return a.id == account.accountId;
      });
      if (full_account.length > 0) full_account = full_account[0];
      full_account.strategy[account.strategy] = parseInt(account.qty);
      // console.log(account);
      if (account.platform == 'xts') {
        XtsAccount.prototype$updateAttributes({
          id: full_account.id
        }, {
          strategy: full_account.strategy
        }).$promise.then(function (resp) {
          $scope.getPositions();
        });
      } else {
        SparkAccount.prototype$updateAttributes({
          id: full_account.id
        }, {
          strategy: full_account.strategy
        }).$promise.then(function (resp) {
          $scope.getPositions();
        });
      }
    }
    $scope.updateBkpLotSizeXts = function (account, qty) {
      let full_account = $scope.accounts.filter(function (a) {
        return a.id == account.accountId;
      });
      if (full_account.length > 0) full_account = full_account[0];
      if (full_account.bkp_strategy) {
        full_account.bkp_strategy[account.strategy] = parseInt(qty);
      } else {
        full_account.bkp_strategy = {
          [account.strategy]: parseInt(qty)
        };
      }
      XtsAccount.prototype$updateAttributes({
        id: full_account.id
      }, {
        bkp_strategy: full_account.bkp_strategy
      });
    }
    $scope.updateLotSize = function (account, name) {
      if (account.platform == 'xts') {
        XtsAccount.prototype$updateAttributes({
          id: account.id
        }, {
          strategy: account.strategy
        }).$promise.then(function (resp) {
          $scope.getPositions();
        });
      } else {
        SparkAccount.prototype$updateAttributes({
          id: account.id
        }, {
          strategy: account.strategy
        }).$promise.then(function (resp) {
          $scope.getPositions();
        });
      }
    }

    $scope.roundOff = function (amount) {
      return String(parseInt(amount)).replace(/(\d)(?=(\d\d)+\d$)/g, "$1,")
    }


    $scope.cashout = function (strategy) {
      if (confirm("Confirm Cashout " + strategy + "?")) {
        Account.cashout({
          strategy: strategy
        }).$promise.then(function () {
          alert('Cashout Done');
        });
      }
    }
    $scope.resetQuantity = function (strategy) {
      if (confirm("Confirm Reset " + strategy + "?")) {
        Account.resetQuantity({
          strategy: strategy
        }).$promise.then(function () {
          alert('Reset Done');
        });
      }
    }

  })
  .controller("ManagerController", function ($scope, $rootScope, $interval, $state, $timeout, Manager, Positional, PaperTrade, Account) {

    $scope.cashout = function (strategy) {
      if (confirm("Confirm Cashout " + strategy + "?")) {
        Account.cashout({
          strategy: strategy
        }).$promise.then(function () {
          alert('Cashout Done');
        });
      }
    }

    $scope.start = function (stg) {
      if (stg.status == 'stopped') {
        if (confirm('Confirm Start ' + stg.name + '? ')) {
          Manager.restart({
            name: stg.module
          }).$promise.then(function (resp) {
            $scope.getRunning();
          });
        }
      } else {
        alert('Strategy not in stopped status');
      }
    }

    $scope.stop = function (stg) {
      if (stg.status == 'online') {
        if (confirm('Confirm Stop ' + stg.name + '? ')) {
          Manager.stop({
            name: stg.module
          }).$promise.then(function (resp) {
            $scope.getRunning();
          });
        }
      } else {
        alert('Strategy not in stopped status');
      }
    }

    $scope.positionalStrategies = $rootScope.positionalStrategies;
    $scope.clearStg = function (stg) {
      if (confirm('Confirm Clear ' + stg.name + '? ')) {
        if ($scope.positionalStrategies.indexOf(stg.name) != -1) {
          Positional.clear({
            strategy: stg.name
          }).$promise.then(function () {
            alert('Cleared');
          });
        } else {
          PaperTrade.clear({
            strategy: stg.name
          }).$promise.then(function () {
            alert('Cleared');
          });
        }
      }
    }

    $scope.strategies = [];
    $scope.getRunning = function () {
      Manager.list().$promise.then(function (resp) {
        $scope.strategies = resp;
      });
    }
    $scope.getRunning();

  });
