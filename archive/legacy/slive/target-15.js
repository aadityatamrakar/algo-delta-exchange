const CronJob = require("cron").CronJob;
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;
const optionConfig = require('../tools/optionInstruments');
const async = require('async');

// Strategy Config
let strategyTag = 'TGT15';
let OTM_DISTANCE = 0; // 0 for ATM straddle, 300 for strangle 300 points away
let TARGET_POINTS = 3; // Target points for either leg
let RESTART_DELAY = 3000 * 3; // 3 seconds delay before placing new position

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

let futureToken,
    currentExpiryOptions = {};
async function runStrategy() {
    try {
        let optionData = await optionConfig();
        futureToken = optionData.currentFuture.token;
        currentExpiryOptions = optionData.weeklyInstruments;
        let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

        let masterId = app.get('masterId');
        let base_acc = await Account.findById(masterId);
        zapi = await zerodha_init(base_acc);
        ticker([futureToken, ...optionTokens]);

        setTimeout(() => { takeTrade(true); }, 5000);
    } catch (err) {
        console.log(err);
    }
}

let ticksCache = {};
async function checkTicks(ticks) {
    let ticks2 = ticks.reduce(function (ob, el) {
        ob[el.instrument_token] = el;
        return ob;
    }, {});
    Object.assign(ticksCache, ticks2);

    checkTargetQ.push({
        check: 1
    });
}

async function getAccounts() {
    let accountsData = await Account.loadAccounts(strategyTag, firstRun);
    accounts = accountsData.accounts;
    account_quantities = accountsData.account_quantities;
    if (firstRun) {
        running_accounts = accountsData.running_accounts;
        firstRun = false;
    }
}

let currentPosition = null;
let isPositionActive = false;
let sellPrices = { ce: 0, pe: 0 };

async function takeTrade(forceTrade = false) {
    try {
        if (isPositionActive) {
            console.log('Position already active, skipping new trade');
            return;
        }

        let bn_quote = ticksCache[futureToken];
        if (!bn_quote) {
            // setTimeout(() => takeTrade(forceTrade), 1000);
            console.log('Future quote not available yet');
            return;
        }

        let atm = Math.round(bn_quote.last_price / 100) * 100;
        let ce_strike = atm + OTM_DISTANCE;
        let pe_strike = atm - OTM_DISTANCE;

        let ce_option = currentExpiryOptions[ce_strike + 'CE'];
        let pe_option = currentExpiryOptions[pe_strike + 'PE'];

        if (!ce_option || !pe_option) {
            console.log('Options not found for strikes:', ce_strike, pe_strike);
            return;
        }

        let ce_ltp = ticksCache[ce_option.instrument_token]?.last_price;
        let pe_ltp = ticksCache[pe_option.instrument_token]?.last_price;

        if (!ce_ltp || !pe_ltp) {
            console.log('LTP not available for options');
            //   setTimeout(() => takeTrade(forceTrade), 1000);
            return;
        }

        // Store sell prices for target calculation
        sellPrices.ce = ce_ltp;
        sellPrices.pe = pe_ltp;

        // Place sell orders
        await sendOrder(ce_option, 'SELL');
        await sendOrder(pe_option, 'SELL');

        currentPosition = {
            atm: atm,
            ce_strike: ce_strike,
            pe_strike: pe_strike,
            ce_option: ce_option,
            pe_option: pe_option,
            entry_time: new Date()
        };

        isPositionActive = true;
        console.log(`New ${OTM_DISTANCE === 0 ? 'Straddle' : 'Strangle'} position taken at ATM: ${atm}`);
        console.log(`CE Strike: ${ce_strike}, PE Strike: ${pe_strike}`);
        console.log(`CE Sell Price: ${sellPrices.ce}, PE Sell Price: ${sellPrices.pe}`);

    } catch (err) {
        console.log('Error in takeTrade:', err);
    }
}

async function checkTarget() {
    if (!isPositionActive || !currentPosition) {
        return;
    }

    try {
        let ce_ltp = ticksCache[currentPosition.ce_option.instrument_token]?.last_price;
        let pe_ltp = ticksCache[currentPosition.pe_option.instrument_token]?.last_price;

        if (!ce_ltp || !pe_ltp) {
            return;
        }

        // Check if either leg has reached target
        let ce_pnl = sellPrices.ce - ce_ltp;
        let pe_pnl = sellPrices.pe - pe_ltp;
        TARGET_POINTS = Math.round((sellPrices.ce + sellPrices.pe) * 0.015)
        let ce_target_hit = ce_ltp <= (sellPrices.ce - TARGET_POINTS);
        let pe_target_hit = pe_ltp <= (sellPrices.pe - TARGET_POINTS);

        if (ce_target_hit || pe_target_hit) {
            console.log(`Target hit! CE LTP: ${ce_ltp}, PE LTP: ${pe_ltp}`);
            console.log(`CE P&L: ${ce_pnl.toFixed(2)}, PE P&L: ${pe_pnl.toFixed(2)}`);

            // Square off both legs
            await sendOrder(currentPosition.ce_option, 'BUY');
            await sendOrder(currentPosition.pe_option, 'BUY');

            // Reset position
            currentPosition = null;
            isPositionActive = false;
            sellPrices = { ce: 0, pe: 0 };

            console.log('Position squared off. Waiting 3 seconds before new trade...');

            // Wait 3 seconds and place new position
            setTimeout(() => {
                takeTrade(true);
            }, RESTART_DELAY);
        }
    } catch (err) {
        console.log('Error in checkTarget:', err);
    }
}

var checkTargetQ = async.queue(function (task, callback) {
    checkTarget().then(function (res) {
        callback();
    });
}, 1);

async function sendOrder(option, transType) {
    try {
        // Paper trade tracking
        PaperTrade.trackOrder(option, transType, strategyTag);
        console.log(`${transType} order placed for ${option.tradingsymbol}`);
    } catch (err) {
        console.log('Error placing order:', err);
    }
}

// Configuration functions
function setOTMDistance(distance) {
    OTM_DISTANCE = distance;
    console.log(`OTM Distance set to: ${distance} (${distance === 0 ? 'Straddle' : 'Strangle'})`);
}

function setTargetPoints(points) {
    TARGET_POINTS = points;
    console.log(`Target points set to: ${points}`);
}

function setRestartDelay(ms) {
    RESTART_DELAY = ms;
    console.log(`Restart delay set to: ${ms}ms`);
}

// Export configuration functions for external use
module.exports = {
    setOTMDistance,
    setTargetPoints,
    setRestartDelay
};

// Start strategy
runStrategy();

// Schedule strategy to run during market hours
// new CronJob('45 16 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');

// Exit at market close
// new CronJob('0 22 15 * * 1-5', function () {
//   console.log('Market closed, exiting strategy...');
//   if (currentPosition && isPositionActive) {
//     console.log('Squaring off open position before exit...');
//     sendOrder(currentPosition.ce_option, 'BUY');
//     sendOrder(currentPosition.pe_option, 'BUY');
//   }
//   setTimeout(function () {
//     process.exit();
//   }, 3000);
// }, null, true, 'Asia/Kolkata');
