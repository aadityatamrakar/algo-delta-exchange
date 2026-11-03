const fs = require('fs');
const axios = require('axios');
const https = require('https');
const agent = new https.Agent({
	rejectUnauthorized: false
});

const RestApi = axios.create({
	baseURL: 'https://103.47.13.50:44441/api',
	timeout: 10000,
	httpsAgent: agent,
	headers: { 'Content-Type': 'application/json' }
});

// axios.defaults.headers.common['Authorization'] = AUTH_TOKEN;

let data = {
	"username": "TEST",
	"password": "Pass@111",
	"platform": "web"
};
let MPIN = '123456';

async function login() {
	let loginResp = await RestApi.post('/accounts/login/', data);

	if (loginResp.status === 200 && loginResp.data.two_factor_authentication) {
		data = {
			"pin": MPIN,
			"token": loginResp.data.two_factor_authentication,
			"username": loginResp.data.username,
			"platform": "web"
		};

		let twoFAResp = await RestApi.post('/accounts/mpin/', data);
		// console.log(twoFAResp);

		if (twoFAResp.status === 200 && twoFAResp.data.message === 'Success') {
			RestApi.defaults.headers.common['Authorization'] = "Token " + twoFAResp.data.access_token;
			console.log('token: ' + twoFAResp.data.access_token);
			console.log('logged in');
			return true;
		}
	}

	return false;
}

async function setToken(token) {
	RestApi.defaults.headers.common['Authorization'] = "token " + token;
}

async function init() {
	await login();
	// let token = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ1c2VybmFtZSI6IlRFU1QiLCJlbWFpbCI6ImFiY0BnbWFpbC5jb20iLCJmaXJzdF9uYW1lIjoidGVzdCIsImxhc3RfbmFtZSI6IiIsInVzZXJfdHlwZSI6ImNsaWVudCIsInRva2VuX3R5cGUiOiJhY2Nlc3MiLCJjcmVhdGVkX2F0IjoxNjU1OTM3NzgxLjY1OTczOSwiZXhwIjoxNjU2MDQzOTgxfQ.sPQ-N0RagzcOmVELHP4H1zoxn-lGPDh7dWufWB8CwRI';
	// setToken(token);
	let account = await margin();
	console.log(account);
	let newOrder = await place_order({
		"client_id": "TEST",
		"side": "buy",
		"product_type": "Intraday",
		"order_type": "market",
		"trigger_price": 0,
		"quantity": 25,
		"price": 0,
		"disclosed_qty": 0,
		"square_off": 0,
		"holding_type": "none",
		"symbol_id": 26156,
		"validity": "day",
		"platform": "web",
		"order_category": "single"
	});
	console.log(newOrder);
	let res = await orders();
	console.log(res);
	let pos = await positions();
	console.log(pos);
	await new Promise(resolve => setTimeout(resolve, 5000));
}

init();

async function download_scrip_master() {
	let symbols = await symbolList();
	let symbolsJson = symbols.split('\n').map(line => {
		let arr = line.split(',');
		return {
			market_id: arr[0],
			security_id: arr[1],
			symbol: arr[2],
			instrument_type: arr[3],
			group_name: arr[4],
			option_type: arr[5],
			scrip_precision: arr[6],
			strike_price: arr[7],
			market_lot: arr[8],
			tick_size: arr[9],
			symbol_id: arr[10],
			expiry_YYYYMMDD: arr[11]
		};
	}).filter(item => item.market_id === 'NSEFO' && item.symbol === 'BANKNIFTY');
	fs.writeFileSync('symbol.json', JSON.stringify(symbolsJson));
}

async function positions() {
	try {
		let res = await RestApi.get('/orders/positions/?page_number=1&page_size=100');
		return res.data;
	} catch (err) {
		console.log(res.data, err);
	}
}

async function orders() {
	try {
		let res = await RestApi.get('/orders/filter/?page_number=1&page_size=100');
		return res.data;
	} catch (err) {
		console.log(res.data, err);
		return [];
	}
}

async function margin() {
	try {
		let res = await RestApi.get('/orders/margin/');
		return res.data;
	} catch (err) {
		console.log(res.data, err);
		return [];
	}
}

async function symbolList() {
	try {
		let res = await RestApi.get('/static_data/scrip_master_csv/');
		return res.data;
	} catch (err) {
		console.log(res.data, err);
		return [];
	}
}

async function place_order(orderObj) {
	let orderResp = await RestApi.post('/orders/', orderObj);
	return orderResp.body;
}