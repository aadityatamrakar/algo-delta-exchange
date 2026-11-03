const CronJob = require("cron").CronJob;
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;
const optionConfig = require('../tools/optionInstruments');
const async = require('async');
const Stoploss = require('../tools/stoploss.js');

// Strategy Config
let strategyTag = 'BN_TIMER_STRADDLE';
let TARGET_POINTS = 5; // Target profit points (5 Rs)
let EXIT_TIMER = 30; // Timer-based exit in seconds (30s)
let ENTRY_DELAY = 5; // Delay between entries in seconds (after exit)
let STRIKES = [0]; // ATM straddles
let PROFIT_TARGET = 2000000; // Exit all positions when profit reaches this amount
let STRATEGY_STOPPED = false; // Flag to stop strategy when profit target is reached

// Initialize Stoploss tracker for overall P&L
let stoplossTracker = new Stoploss();

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
        console.log('Timer-based Straddle Strategy - Live Feed Connected');
        liveFeed.subscribe(subs);
        liveFeed.setMode(liveFeed.modeFull, subs);
    });
}
let futureToken,
    currentExpiryOptions = {};

// Single straddle tracking system
let currentStraddle = {
    active: null, // Current active straddle object
    totalStraddlesCreated: 0,
    baseATM: null,
    waitingForEntry: false
};

// Single Straddle structure:
// {
//   id: unique_id,
//   strikeOffset: strike_offset,
//   qty: quantity,
//   entryPrice: combined_entry_price,
//   targetPrice: entry_price + target_points,
//   entryTime: entry_timestamp,
//   exitTimer: timer_in_seconds,
//   timerHandle: setTimeout_handle,
//   ce: { option, entryPrice, lastPrice },
//   pe: { option, entryPrice, lastPrice },
//   isActive: true/false,
//   exitReason: 'TARGET'|'TIMER'|'MANUAL'
// }

async function runStrategy() {
    try {
        let optionData = await optionConfig();
        futureToken = 260105;
        currentExpiryOptions = optionData.weeklyInstruments;
        let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

        let masterId = app.get('masterId');
        let base_acc = await Account.findById(masterId);
        await zerodha_init(base_acc);
        ticker([futureToken, ...optionTokens]);

        setTimeout(() => { startTimerStraddles(); }, 5000);
    } catch (err) {
        console.log('Error in runStrategy:', err);
    }
}

let ticksCache = {};
async function checkTicks(ticks) {
    let ticks2 = ticks.reduce(function (ob, el) {
        ob[el.instrument_token] = el;
        return ob;
    }, {});
    Object.assign(ticksCache, ticks2);

    checkPositionsQ.push({ check: 1 });
}

async function startTimerStraddles() {
    try {
        let bn_quote = ticksCache[futureToken];
        if (!bn_quote) {
            console.log('Future quote not available yet');
            setTimeout(() => startTimerStraddles(), 1000);
            return;
        }

        // Calculate synthetic future price using put-call parity
        let syntheticATM = await calculateSyntheticATM(bn_quote.last_price);
        currentStraddle.baseATM = syntheticATM;

        console.log(`Starting Timer-based Straddle Strategy:`);
        console.log(`  Actual Future Price: ${bn_quote.last_price}`);
        console.log(`  Synthetic ATM: ${syntheticATM}`);
        console.log(`  Target: ${TARGET_POINTS} Rs | Timer: ${EXIT_TIMER}s | Sequential Entry Mode`);

        // Start with first straddle
        await createSingleStraddle();
    } catch (err) {
        console.log('Error in startTimerStraddles:', err);
    }
}

async function createSingleStraddle() {
    try {
        if (STRATEGY_STOPPED) {
            console.log('❌ Strategy stopped - no more entries');
            return;
        }

        // Don't create if already active or waiting
        if (currentStraddle.active || currentStraddle.waitingForEntry) {
            return;
        }

        let bn_quote = ticksCache[futureToken];
        if (!bn_quote) {
            console.log('Future quote not available, retrying in 1s...');
            setTimeout(() => createSingleStraddle(), 1000);
            return;
        }

        // Recalculate synthetic ATM for fresh entry
        let syntheticATM = await calculateSyntheticATM(bn_quote.last_price);
        await createTimerStraddle(syntheticATM, 0, 1); // ATM straddle with qty 1

    } catch (err) {
        console.log('Error in createSingleStraddle:', err);
        // Retry after delay
        setTimeout(() => createSingleStraddle(), 5000);
    }
}

// Calculate synthetic future price using put-call parity: F = S + C - P
async function calculateSyntheticATM(actualFuturePrice) {
    try {
        let baseStrike = Math.round(actualFuturePrice / 100) * 100;
        let atmCall = currentExpiryOptions[baseStrike + 'CE'];
        let atmPut = currentExpiryOptions[baseStrike + 'PE'];

        if (!atmCall || !atmPut) {
            console.log('ATM options not found, using actual future price');
            return baseStrike;
        }

        let callPrice = ticksCache[atmCall.instrument_token]?.last_price;
        let putPrice = ticksCache[atmPut.instrument_token]?.last_price;

        if (!callPrice || !putPrice) {
            console.log('Option prices not available, using actual future price');
            return baseStrike;
        }

        let syntheticFuture = baseStrike + callPrice - putPrice;
        let syntheticATM = Math.round(syntheticFuture / 100) * 100;

        console.log(`Synthetic Future Calculation:`);
        console.log(`  Base Strike: ${baseStrike}`);
        console.log(`  ATM Call (${atmCall.tradingsymbol}): ₹${callPrice}`);
        console.log(`  ATM Put (${atmPut.tradingsymbol}): ₹${putPrice}`);
        console.log(`  Synthetic Future: ${baseStrike} + ${callPrice} - ${putPrice} = ${syntheticFuture.toFixed(2)}`);
        console.log(`  Synthetic ATM: ${syntheticATM}`);

        return syntheticATM;
    } catch (err) {
        console.log('Error calculating synthetic ATM:', err);
        return Math.round(actualFuturePrice / 100) * 100;
    }
}

async function createTimerStraddle(atm, strikeOffset, qty) {
    try {
        // Don't create new straddles if strategy is stopped
        if (STRATEGY_STOPPED) {
            console.log(`❌ Strategy stopped - not creating new timer straddle`);
            return;
        }

        // Check if already have active straddle
        if (currentStraddle.active) {
            console.log('⚠️ Already have active straddle, skipping...');
            return;
        }

        let ce_strike = atm + strikeOffset;
        let pe_strike = atm + strikeOffset;

        let ce_option = currentExpiryOptions[ce_strike + 'CE'];
        let pe_option = currentExpiryOptions[pe_strike + 'PE'];

        if (!ce_option || !pe_option) {
            console.log(`Options not found for strike offset ${strikeOffset}`);
            return;
        }

        let ce_ltp = ticksCache[ce_option.instrument_token]?.last_price;
        let pe_ltp = ticksCache[pe_option.instrument_token]?.last_price;

        if (!ce_ltp || !pe_ltp) {
            console.log(`LTP not available for strike offset ${strikeOffset}`);
            return;
        }

        // Create new timer straddle
        let straddleId = ++currentStraddle.totalStraddlesCreated;
        let entryPrice = ce_ltp + pe_ltp;
        let targetPrice = entryPrice + TARGET_POINTS;

        let newStraddle = {
            id: straddleId,
            strikeOffset: strikeOffset,
            qty: qty,
            entryPrice: entryPrice,
            targetPrice: targetPrice,
            entryTime: new Date(),
            exitTimer: EXIT_TIMER,
            timerHandle: null,
            ce: {
                option: ce_option,
                entryPrice: ce_ltp,
                lastPrice: ce_ltp
            },
            pe: {
                option: pe_option,
                entryPrice: pe_ltp,
                lastPrice: pe_ltp
            },
            isActive: true,
            exitReason: null
        };

        // Set as current active straddle
        currentStraddle.active = newStraddle;

        // Place buy orders for both CE and PE
        await sendOrder(ce_option, 'BUY', qty, straddleId);
        await sendOrder(pe_option, 'BUY', qty, straddleId);

        // Set timer for automatic exit
        newStraddle.timerHandle = setTimeout(async () => {
            try {
                if (currentStraddle.active && currentStraddle.active.id === straddleId) {
                    console.log(`⏰ TIMER EXPIRED for Straddle #${straddleId} after ${EXIT_TIMER}s`);
                    await exitCurrentStraddle('TIMER');
                }
            } catch (err) {
                console.log(`Error in timer exit for straddle ${straddleId}:`, err);
            }
        }, EXIT_TIMER * 1000);

        let strikeKey = strikeOffset === 0 ? 'ATM' : (strikeOffset > 0 ? `P${strikeOffset}` : `M${Math.abs(strikeOffset)}`);
        console.log(`⏱️ TIMER STRADDLE #${straddleId} (${strikeKey}): Qty=${qty}, Entry=₹${entryPrice.toFixed(2)}, Target=₹${targetPrice.toFixed(2)} (+${TARGET_POINTS} Rs), Timer=${EXIT_TIMER}s`);
        console.log(`   CE: ${ce_option.tradingsymbol} @ ₹${ce_ltp} | PE: ${pe_option.tradingsymbol} @ ₹${pe_ltp}`);
        console.log(`   Total Straddles Created: ${currentStraddle.totalStraddlesCreated}`);

    } catch (err) {
        console.log(`Error creating timer straddle:`, err);
    }
}

async function checkPositions() {
    try {
        // Check overall P&L and stop strategy if profit target reached
        if (!STRATEGY_STOPPED) {
            let overallPNL = stoplossTracker.getPNL(ticksCache);
            if (overallPNL >= PROFIT_TARGET) {
                console.log(`🎯 PROFIT TARGET REACHED! Overall P&L: ₹${overallPNL.toFixed(2)} >= ₹${PROFIT_TARGET}`);
                STRATEGY_STOPPED = true;
                await exitCurrentStraddle('MANUAL');
                return;
            }
        }

        // If strategy is stopped, don't check positions
        if (STRATEGY_STOPPED) {
            return;
        }

        // Check active straddle for target hit
        await checkCurrentStraddle();

    } catch (err) {
        console.log('Error in checkPositions:', err);
    }
}

async function checkCurrentStraddle() {
    try {
        let straddle = currentStraddle.active;
        if (!straddle || !straddle.isActive) return;

        let ce_ltp = ticksCache[straddle.ce.option.instrument_token]?.last_price;
        let pe_ltp = ticksCache[straddle.pe.option.instrument_token]?.last_price;

        if (!ce_ltp || !pe_ltp) return;

        // Update last prices
        straddle.ce.lastPrice = ce_ltp;
        straddle.pe.lastPrice = pe_ltp;
        let currentPrice = ce_ltp + pe_ltp;

        // Check for target hit (exit immediately if target reached)
        if (currentPrice >= straddle.targetPrice) {
            console.log(`🎯 TARGET HIT for Timer Straddle #${straddle.id}! Current: ₹${currentPrice.toFixed(2)}, Target: ₹${straddle.targetPrice.toFixed(2)}`);
            await exitCurrentStraddle('TARGET');
        }

    } catch (err) {
        console.log('Error checking current straddle:', err);
    }
}

async function exitCurrentStraddle(reason) {
    try {
        let straddle = currentStraddle.active;
        if (!straddle) return;

        // Clear the timer if it exists
        if (straddle.timerHandle) {
            clearTimeout(straddle.timerHandle);
            straddle.timerHandle = null;
        }

        // Place sell orders for both CE and PE
        await sendOrder(straddle.ce.option, 'SELL', straddle.qty, straddle.id);
        await sendOrder(straddle.pe.option, 'SELL', straddle.qty, straddle.id);

        // Calculate P&L
        let exitPrice = straddle.ce.lastPrice + straddle.pe.lastPrice;
        let pnl = (exitPrice - straddle.entryPrice) * straddle.qty;
        let holdTime = Math.round((new Date() - straddle.entryTime) / 1000); // seconds

        straddle.exitReason = reason;

        let reasonEmoji = reason === 'TARGET' ? '🎯' : reason === 'TIMER' ? '⏰' : '🔄';
        console.log(`${reasonEmoji} TIMER STRADDLE #${straddle.id} EXITED (${reason})`);
        console.log(`   Qty: ${straddle.qty} | Entry: ₹${straddle.entryPrice.toFixed(2)} | Exit: ₹${exitPrice.toFixed(2)} | P&L: ₹${pnl.toFixed(2)} | Hold: ${holdTime}s`);
        console.log(`   CE Exit: ₹${straddle.ce.lastPrice} | PE Exit: ₹${straddle.pe.lastPrice}`);

        // Mark as inactive and clear current straddle
        straddle.isActive = false;
        currentStraddle.active = null;

        // Schedule next straddle entry after delay (only if not manually stopped)
        if (!STRATEGY_STOPPED && reason !== 'MANUAL') {
            console.log(`🔄 Scheduling next straddle entry in ${ENTRY_DELAY} seconds...`);
            currentStraddle.waitingForEntry = true;

            setTimeout(async () => {
                try {
                    currentStraddle.waitingForEntry = false;
                    if (!STRATEGY_STOPPED) {
                        console.log(`⏰ Entry delay completed, creating new straddle...`);
                        await createSingleStraddle();
                    }
                } catch (err) {
                    console.log('Error in delayed entry:', err);
                    currentStraddle.waitingForEntry = false;
                }
            }, ENTRY_DELAY * 1000);
        }

    } catch (err) {
        console.log(`Error exiting current straddle:`, err);
    }
}

// Remove the old exitAllTimerStraddles function - not needed for single straddle

var checkPositionsQ = async.queue(function (task, callback) {
    checkPositions().then(function (res) {
        callback();
    });
}, 1);

async function sendOrder(option, transType, qty = 1, straddleId = null) {
    try {
        let price = ticksCache[option.instrument_token]?.last_price || 0;

        // Track order in stoploss tracker for P&L calculation
        stoplossTracker.addOrder(option, price, transType, qty);

        // Paper trade tracking
        PaperTrade.trackOrder(option, transType, strategyTag, qty);

        let prefix = straddleId ? `[#${straddleId}]` : '';
        console.log(`📋 ${prefix} ${transType} order placed for ${option.tradingsymbol} (Qty: ${qty}) @ ₹${price}`);
    } catch (err) {
        console.log('Error placing order:', err);
    }
}

// Status reporting function
function getStrategyStatus() {
    console.log('\n📊 Sequential Timer Straddle Strategy Status:');
    console.log('=====================================');

    let overallPNL = 0;
    try {
        overallPNL = stoplossTracker.getPNL(ticksCache);
    } catch (err) {
        console.log('Error calculating overall P&L:', err);
    }

    let actualFuture = ticksCache[futureToken]?.last_price || 0;
    console.log(`💰 Overall P&L: ₹${overallPNL.toFixed(2)} | Target: ₹${PROFIT_TARGET} | Status: ${STRATEGY_STOPPED ? '🛑 STOPPED' : '✅ ACTIVE'}`);
    console.log(`📈 Actual Future: ${actualFuture} | Base ATM: ${currentStraddle.baseATM || 'N/A'}`);
    console.log(`⚙️ Config: Target=${TARGET_POINTS} Rs | Timer=${EXIT_TIMER}s | Entry Delay=${ENTRY_DELAY}s | Mode=Sequential`);
    console.log(`📊 Total Created: ${currentStraddle.totalStraddlesCreated} | Waiting for Entry: ${currentStraddle.waitingForEntry ? 'YES' : 'NO'}`);

    if (currentStraddle.active) {
        let straddle = currentStraddle.active;
        let currentPrice = straddle.ce.lastPrice + straddle.pe.lastPrice;
        let unrealizedPnl = (currentPrice - straddle.entryPrice) * straddle.qty;
        let timeElapsed = Math.round((new Date() - straddle.entryTime) / 1000); // seconds
        let timeRemaining = Math.max(0, straddle.exitTimer - timeElapsed);

        console.log('\nActive Straddle:');
        console.log(`  #${straddle.id}: Entry=₹${straddle.entryPrice.toFixed(2)} | Current=₹${currentPrice.toFixed(2)} | Target=₹${straddle.targetPrice.toFixed(2)}`);
        console.log(`       P&L: ₹${unrealizedPnl.toFixed(2)} | Elapsed: ${timeElapsed}s | Remaining: ${timeRemaining}s`);
        console.log(`       CE: ₹${straddle.ce.lastPrice} (${straddle.ce.option.tradingsymbol})`);
        console.log(`       PE: ₹${straddle.pe.lastPrice} (${straddle.pe.option.tradingsymbol})`);
    } else {
        console.log('\nNo Active Straddle');
    }
    console.log('=====================================\n');
}

// Configuration functions
function setTargetPoints(points) {
    TARGET_POINTS = points;
    console.log(`Target points set to: ${points} Rs`);
}

function setExitTimer(seconds) {
    EXIT_TIMER = seconds;
    console.log(`Exit timer set to: ${seconds} seconds`);
}

function setEntryDelay(seconds) {
    ENTRY_DELAY = seconds;
    console.log(`Entry delay set to: ${seconds} seconds`);
}

function setMaxConcurrentStraddles(count) {
    console.log(`⚠️ Sequential mode - concurrent straddles setting ignored. Always runs one straddle at a time.`);
}

function setProfitTarget(amount) {
    PROFIT_TARGET = amount;
    console.log(`Profit target set to: ₹${amount}`);
}

// Export functions
module.exports = {
    setTargetPoints,
    setExitTimer,
    setEntryDelay,
    setMaxConcurrentStraddles,
    setProfitTarget,
    getStrategyStatus
};

// Start strategy
// runStrategy();

// Status reporting every 30 seconds
setInterval(getStrategyStatus, 30000);

// Schedule strategy to run during market hours
new CronJob('45 16 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');

// Exit at market close
new CronJob('0 21 15 * * 1-5', function () {
    console.log('Market closed, exiting strategy...');
    STRATEGY_STOPPED = true;
    // Exit current active straddle if any
    if (currentStraddle.active && currentStraddle.active.isActive) {
        exitCurrentStraddle('MANUAL');
    }
    setTimeout(function () {
        process.exit();
    }, 5000);
}, null, true, 'Asia/Kolkata');