var request = require('request');

function placeOrder() {
	var options = {
		'method': 'POST',
		'url': 'https://klevertrade.arhamwealth.com/api/v1/orders',
		'headers': {
			'Authorization': 'Bearer 9lOvd4lv2ano8P7lLuA637rM1a8FbOI7ZpnQIrux9zo.kN09WZtnn_qjVYw9SPMkSPIOlPrjd7ZbEhNjH-P7SpA',
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			"exchange": "NFO",
			"order_type": "MARKET",
			"instrument_token": 53416,
			"quantity": 25,
			"price": 0,
			"order_side": "BUY",
			"trigger_price": 0,
			"validity": "DAY",
			"product": "MIS",
			"client_id": "AW0198",
			"user_order_id": 1,
			"device": "WEB",
			"disclosed_quantity": 0,
			"execution_type": "AMO"
		})

	};

	let timeId = 'orderStart' + parseInt(Math.random() * 99999999);
	console.time(timeId);
	request(options, function (error, response) {
		if (error) throw new Error(error);
		console.timeEnd(timeId);
		// console.log(response.body);
	});
}
function cancelOrder(orderId) {
	var options = {
		'method': 'DELETE',
		'url': 'https://klevertrade.arhamwealth.com/api/v1/orders/' + orderId + '?client_id=AW0198&execution_type=AMO',
		'headers': {
			'Authorization': 'Bearer 9lOvd4lv2ano8P7lLuA637rM1a8FbOI7ZpnQIrux9zo.kN09WZtnn_qjVYw9SPMkSPIOlPrjd7ZbEhNjH-P7SpA'
		}
	};
	request(options, function (error, response) {
		if (error) throw new Error(error);
		console.log(response.body);
	});

}
function init() {

	// place order 30 times
	// for (var i = 0; i < 30; i++) {
	// 	placeOrder();
	// }
	let orderIds = ["20220323-63", "20220323-65", "20220323-69", "20220323-74", "20220323-80", "20220323-90", "20220323-75", "20220323-84", "20220323-85", "20220323-64", "20220323-67", "20220323-78", "20220323-76", "20220323-82", "20220323-71", "20220323-86", "20220323-62", "20220323-89", "20220323-88", "20220323-87", "20220323-73", "20220323-72", "20220323-68", "20220323-91", "20220323-79", "20220323-81", "20220323-83", "20220323-70", "20220323-66", "20220323-59", "20220323-48", "20220323-49", "20220323-41", "20220323-54", "20220323-57", "20220323-36", "20220323-58", "20220323-38", "20220323-51", "20220323-55", "20220323-53", "20220323-32", "20220323-46", "20220323-56", "20220323-61", "20220323-52", "20220323-40", "20220323-37", "20220323-45", "20220323-50", "20220323-39", "20220323-42", "20220323-34", "20220323-43", "20220323-44", "20220323-47", "20220323-35", "20220323-60", "20220323-33", "20220323-15", "20220323-17", "20220323-4", "20220323-2", "20220323-29", "20220323-6", "20220323-14", "20220323-16", "20220323-28", "20220323-8", "20220323-22", "20220323-19", "20220323-20", "20220323-27", "20220323-3", "20220323-26", "20220323-25", "20220323-31", "20220323-10", "20220323-9", "20220323-13", "20220323-24", "20220323-30", "20220323-5", "20220323-7", "20220323-23", "20220323-11", "20220323-21", "20220323-12", "20220323-18", "20220323-1"];
	// cancel all orderIds
	for (var i = 0; i < orderIds.length; i++) {
		cancelOrder(orderIds[i]);
	}

}


// init();


var ClientOAuth2 = require('client-oauth2')

var githubAuth = new ClientOAuth2({
	clientId: 'ARHAM-AW0198',
	clientSecret: 'Yyam2azpmuEsPsaFkjdWMjn17G6Xl2wpfI8GD6zx3koDVip1ja0yTC5YRN80qE7s',
	accessTokenUri: 'https://klevertrade.arhamwealth.com/oauth2/token',
	authorizationUri: 'https://klevertrade.arhamwealth.com/oauth2/auth',
	redirectUri: 'http://127.0.0.1/',
	scopes: ['orders', 'holdings'],
	state: "{\"param\": \"value\"}"
})

function getURI() {
	var uri = githubAuth.code.getUri();
	console.log(uri)
}

function getToken(url) {
	githubAuth.code.getToken(url)
		.then(function (user) {
			console.log(user) //=> { accessToken: '...', tokenType: 'bearer', ... }

			// Refresh the current users access token.
			user.refresh().then(function (updatedUser) {
				console.log(updatedUser !== user) //=> true
				console.log(updatedUser.accessToken)
			});

			// 'https://klevertrade.arhamwealth.com/api/v1/user/trading_info'
			
		})
}

getURI();
getToken('http://127.0.0.1/?code=3-bTnGbo8Ft6i8Jy6xlYUi-MSNq2X-_eBai_1dztp-E.pe7ttH_iIWOtpRsfVZ7hejKBOLWj23X60FHEf3O1Uhg&scope=orders%20holdings&state=%7B%22param%22%3A%20%22value%22%7D');