const CronJob = require("cron").CronJob;
const notify = require("../lib/notify.js");
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const optionConfig = require('../tools/optionInstruments');
const async = require('async');
const otmSelector = require('../lib/otmSelector');
const moment = require('moment');

// Strategy Config
let channelId = 0;
let strategyTag = 'STGL-25';

let zapi;
let public_token;
async function zerodha_init(account) {
    let zapi_n = new zerodha();
    zapi_n.loadConfig(account);
    let login_resp = await zapi_n.login();
    account.lastLogin = (new Date()).toISOString().substr(0, 10);
    account.config = await zapi_n.getConfig();
    public_token = zapi_n.getAuthorization();
    await account.save();
    if (login_resp === false) return false;
    else return zapi_n;
}

let liveFeed;
async function ticker(subs) {
    liveFeed = new kiteTicker({
        api_key: 'kitefront',
        access_token: public_token
    });
    liveFeed.connect();
    liveFeed.on("ticks", checkTicks);
    liveFeed.on("connect", function () {
        console.log('Live Feed Connected');
        liveFeed.subscribe(subs);
        liveFeed.setMode(liveFeed.modeFull, subs);
    });
}

let accounts = [],
    running_accounts = [],
    account_quantities = {},
    firstRun = true;
async function getAccounts() {
    let accountsData = await Account.loadAccounts(strategyTag, firstRun);
    accounts = accountsData.accounts;
    account_quantities = accountsData.account_quantities;
    if (firstRun) {
        running_accounts = accountsData.running_accounts;
        firstRun = false;
    }
}

let futureToken, currentExpiryOptions = {},
    fromDate, toDate;
async function runStrategy() {
    try {
        let optionData = await optionConfig();
        futureToken = 260105;
        currentExpiryOptions = optionData.weeklyInstruments;
        if (moment().day() == 3) {
            currentExpiryOptions = optionData.nextWeekInstruments;
        }
        let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

        // farOtm = otmSelector();
        // await getAccounts();
        let masterId = app.get('masterId');
        let base_acc = await Account.findById(masterId);
        zapi = await zerodha_init(base_acc);
        ticker([futureToken, ...optionTokens]);

        setTimeout(function () {
            lastQuote = ticksCache[futureToken].last_price;
            setTimeout(function () {
                startTrade = true;
                placeTrade(true, 100);
                placeTrade(true, 200);
                placeTrade(true, 300);
            }, 5000);
        }, 5000);
    } catch (err) {
        console.log('main err', err);
    }
}

let optionOrders = [],
    ATM_Strike = [],
    positionsOpen = [],
    sl_percent = 1.25;

let ticksCache = {},
    startTrade = false;
async function checkTicks(ticks) {
    let ticks2 = ticks.reduce(function (ob, el) {
        ob[el.instrument_token] = el;
        return ob;
    }, {});
    Object.assign(ticksCache, ticks2);

    checkSLQ.push({
        check: 1
    });
}

let lastQuote;
async function placeTrade(forceTrade = false, farOtm = 100) {
    let bn_quote = ticksCache[futureToken];
    let new_ATM_Strike = (Math.round(bn_quote.last_price / 100) * 100);
    let isCrossover = forceTrade;
    lastQuote = bn_quote.last_price;

    if (isCrossover) {
        let ce_option = currentExpiryOptions[(new_ATM_Strike + farOtm) + "CE"];
        let pe_option = currentExpiryOptions[(new_ATM_Strike - farOtm) + "PE"];

        // console.log(new_ATM_Strike);
        ATM_Strike.push("S" + new_ATM_Strike);

        let ce_ltp = ticksCache[ce_option.instrument_token].last_price;
        await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, ce_option, 'SELL', 10);
        optionOrders.push({
            atm: new_ATM_Strike,
            strike: ce_option.strike,
            type: "CE",
            instrument_token: ce_option.instrument_token,
            sl_trigger: ce_ltp * sl_percent,
            sl_hit: false
        });
        let pe_ltp = ticksCache[pe_option.instrument_token].last_price;
        await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, pe_option, 'SELL', 10);
        optionOrders.push({
            atm: new_ATM_Strike,
            strike: pe_option.strike,
            type: "PE",
            instrument_token: pe_option.instrument_token,
            sl_trigger: pe_ltp * sl_percent,
            sl_hit: false
        });

        return true;
    }
}

async function checkSL() {
    optionOrders.forEach(async (ce_position, idx) => {
        let check_option = ce_position;
        if (ticksCache[check_option.instrument_token].last_price > check_option.sl_trigger) {
            delete optionOrders[idx];
            await Account.placeAllAccount(strategyTag, account_quantities, running_accounts, currentExpiryOptions[check_option.strike + check_option.type], 'BUY', 10);
            return false;
        } else return true;
    });
}

var takePositionQ = async.queue(function (task, callback) {
    placeTrade().then(function (res) {
        callback();
    });
}, 1);
var checkSLQ = async.queue(function (task, callback) {
    checkSL().then(function (res) {
        callback();
    });
}, 1);

// runStrategy();
new CronJob('0 20 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
new CronJob('40 23 15 * * 1-5', async function () {
    setTimeout(function () {
        process.exit();
    }, 15000);
}, null, true, 'Asia/Kolkata');
