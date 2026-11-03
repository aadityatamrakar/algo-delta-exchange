angular
	.module('app')
	.factory('ChangeStream', function ($rootScope, $window, $state) {
		let access_token = $window.localStorage.getItem('$LoopBack$accessTokenId');
		let userId = $window.localStorage.getItem('$LoopBack$currentUserId');
		// let socketUrl = 'wss://algospot.in/';
		let socketUrl = '/';
		// let socketUrl = '3.6.199.136';

		var socket = io(socketUrl, {
			transports: ['websocket'],
			query: {
				token: access_token ? access_token : false,
				userId: userId ? userId : false
			},
			pingInterval: 3000,
			timeout: 30000,
		});

		socket.on('onConnect', function (resp) {
			running = resp;
		});

		// REMOVED 2026-07-25: `socket.on('execute', resp => eval(resp))`.
		//
		// This executed an arbitrary string pushed over the socket, i.e. remote code
		// execution in every open dashboard for anyone able to emit on the channel.
		// Verified dead: nothing in server/, common/ or legacy/ ever emits 'execute',
		// so it provided no functionality — only attack surface.
		//
		// If server-driven client actions are ever needed, use an explicit
		// message-type switch over a closed set of named commands with validated
		// arguments. Never eval a payload.

		socket.on('statechange', (resp) => {
			$state.go(resp.name, resp.data);
		});

		socket.on('online', function (count) {
			$rootScope.usersOnline = count;
			$rootScope.$apply();
		});
		socket.on('online_users', function (count) {
			$rootScope.usersOnline = count;
			$rootScope.$apply();
		});

		socket.on('notify', (data) => {
			console.log(data);
			alert(data.message);
		});

		socket.on('disconnect', function () {
			console.log('disconnected to server');
		});

		function startSocket() {
			access_token = $window.localStorage.getItem('$LoopBack$accessTokenId');
			userId = $window.localStorage.getItem('$LoopBack$currentUserId');
			socket.io.opts.query.token = access_token;
			socket.io.opts.query.userId = userId;
			socket.io.disconnect();
			socket.io.open();
		}

		let running = {};

		return {
			start: startSocket,
			running: () => {
				console.log(running);
				return running;
			},
			on: function (eventName, callback) {
				socket.on(eventName, function () {
					var args = arguments;
					$rootScope.$apply(function () {
						callback.apply(socket, args);
					});
				});

			},
			emit: function (eventName, data, callback) {
				socket.emit(eventName, data, function () {
					var args = arguments;
					$rootScope.$apply(function () {
						if (callback) {
							callback.apply(socket, args);
						}
					});
				});
			}
		};
	})

	.factory('ParityFeed', function ($rootScope, $window, $state) {
		// let socketUrl = window.location.host + ':3000';
		let socketUrl = '3.6.199.136:3000';

		var socket = io(socketUrl, {
			transports: ['websocket'],
			pingInterval: 3000,
			timeout: 30000,
		});

		socket.on('onConnect', function (resp) {
			running = resp;
		});

		// REMOVED 2026-07-25: `socket.on('execute', resp => eval(resp))`.
		//
		// This executed an arbitrary string pushed over the socket, i.e. remote code
		// execution in every open dashboard for anyone able to emit on the channel.
		// Verified dead: nothing in server/, common/ or legacy/ ever emits 'execute',
		// so it provided no functionality — only attack surface.
		//
		// If server-driven client actions are ever needed, use an explicit
		// message-type switch over a closed set of named commands with validated
		// arguments. Never eval a payload.

		socket.on('statechange', (resp) => {
			$state.go(resp.name, resp.data);
		});

		socket.on('online', function (count) {
			$rootScope.usersOnline = count;
			$rootScope.$apply();
		});
		socket.on('online_users', function (count) {
			$rootScope.usersOnline = count;
			$rootScope.$apply();
		});

		socket.on('notify', (data) => {
			console.log(data);
			alert(data.message);
		});

		socket.on('disconnect', function () {
			console.log('disconnected to server');
		});

		function startSocket() {
			access_token = $window.localStorage.getItem('$LoopBack$accessTokenId');
			userId = $window.localStorage.getItem('$LoopBack$currentUserId');
			socket.io.opts.query.token = access_token;
			socket.io.opts.query.userId = userId;
			socket.io.disconnect();
			socket.io.open();
		}

		let running = {};

		return {
			start: startSocket,
			running: () => {
				console.log(running);
				return running;
			},
			on: function (eventName, callback) {
				socket.on(eventName, function () {
					var args = arguments;
					$rootScope.$apply(function () {
						callback.apply(socket, args);
					});
				});

			},
			emit: function (eventName, data, callback) {
				socket.emit(eventName, data, function () {
					var args = arguments;
					$rootScope.$apply(function () {
						if (callback) {
							callback.apply(socket, args);
						}
					});
				});
			}
		};
	});
