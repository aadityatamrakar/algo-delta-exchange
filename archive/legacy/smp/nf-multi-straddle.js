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
let strategyTag = 'NF_MULTI_STRADDLE';
let INITIAL_TARGET_POINTS = 5; // Initial target points
let NEW_TRIGGER = 5; // Price drop trigger for new straddle (10 Rs)
let TARGET_INCREMENT = 2; // Increase target by 2 points for each new straddle
let MAX_STRADDLES = 10; // Maximum number of concurrent straddles allowed
let STRIKES = [0]; // ATM straddles
let PROFIT_TARGET = 2000000; // Exit all positions when profit reaches this amount
let RE_ENTRY_DELAY = 15000; // Delay in milliseconds before re-entering after target hit (15 seconds)
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
        console.log('Multi Straddle Strategy - Live Feed Connected');
        liveFeed.subscribe(subs);
        liveFeed.setMode(liveFeed.modeFull, subs);
    });
}
let futureToken,
    currentExpiryOptions = {};

// Multi-straddle tracking system
let straddleSystem = {
    nextId: 1,
    activeStraddles: new Map(), // Map of straddleId -> straddle details
    lastEntryPrice: null, // Track last entry price for trigger calculation
    totalStraddlesCreated: 0,
    baseATM: null
};

// Straddle structure:
// {
//   id: unique_id,
//   strikeOffset: strike_offset,
//   qty: quantity,
//   entryPrice: combined_entry_price,
//   targetPrice: entry_price + target_points,
//   targetPoints: target_for_this_straddle,
//   timestamp: entry_time,
//   ce: { option, entryPrice, lastPrice },
//   pe: { option, entryPrice, lastPrice },
//   isActive: true/false
// }

async function runStrategy() {
    try {
        let optionData = await optionConfig('NIFTY');
        futureToken = 256265;
        currentExpiryOptions = optionData.weeklyInstruments;
        let optionTokens = Object.values(currentExpiryOptions).map(c => c.instrument_token);

        let masterId = app.get('masterId');
        let base_acc = await Account.findById(masterId);
        await zerodha_init(base_acc);
        ticker([futureToken, ...optionTokens]);

        setTimeout(() => { startInitialStraddles(); }, 5000);
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

async function startInitialStraddles() {
    try {
        let bn_quote = ticksCache[futureToken];
        if (!bn_quote) {
            console.log('Future quote not available yet');
            setTimeout(() => startInitialStraddles(), 1000);
            return;
        }

        // Calculate synthetic future price using put-call parity
        let syntheticATM = await calculateSyntheticATM(bn_quote.last_price);
        straddleSystem.baseATM = syntheticATM;

        console.log(`Starting Multi Straddle Strategy:`);
        console.log(`  Actual Future Price: ${bn_quote.last_price}`);
        console.log(`  Synthetic ATM: ${syntheticATM}`);

        // Create initial straddles for all strikes
        for (let strike of STRIKES) {
            await createNewStraddle(syntheticATM, strike, 1, INITIAL_TARGET_POINTS);
        }
    } catch (err) {
        console.log('Error in startInitialStraddles:', err);
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

async function createNewStraddle(atm, strikeOffset, qty, targetPoints) {
    try {
        // Don't create new straddles if strategy is stopped
        if (STRATEGY_STOPPED) {
            console.log(`❌ Strategy stopped - not creating new straddle`);
            return;
        }

        // Check max straddles limit
        if (straddleSystem.activeStraddles.size >= MAX_STRADDLES) {
            console.log(`⚠️ MAX STRADDLES LIMIT REACHED! Active: ${straddleSystem.activeStraddles.size}/${MAX_STRADDLES}`);
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

        // Create new straddle
        let straddleId = straddleSystem.nextId++;
        let entryPrice = ce_ltp + pe_ltp;
        let targetPrice = entryPrice + targetPoints;

        let newStraddle = {
            id: straddleId,
            strikeOffset: strikeOffset,
            qty: qty,
            entryPrice: entryPrice,
            targetPrice: targetPrice,
            targetPoints: targetPoints,
            timestamp: new Date(),
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
            isActive: true
        };

        // Add to active straddles
        straddleSystem.activeStraddles.set(straddleId, newStraddle);
        straddleSystem.totalStraddlesCreated++;
        straddleSystem.lastEntryPrice = entryPrice;

        // Place buy orders for both CE and PE
        await sendOrder(ce_option, 'BUY', qty, straddleId);
        await sendOrder(pe_option, 'BUY', qty, straddleId);

        let strikeKey = strikeOffset === 0 ? 'ATM' : (strikeOffset > 0 ? `P${strikeOffset}` : `M${Math.abs(strikeOffset)}`);
        console.log(`🆕 NEW STRADDLE #${straddleId} (${strikeKey}): Qty=${qty}, Entry=₹${entryPrice.toFixed(2)}, Target=₹${targetPrice.toFixed(2)} (+${targetPoints} pts)`);
        console.log(`   CE: ${ce_option.tradingsymbol} @ ₹${ce_ltp} | PE: ${pe_option.tradingsymbol} @ ₹${pe_ltp}`);
        console.log(`   Active Straddles: ${straddleSystem.activeStraddles.size}/${MAX_STRADDLES}`);

    } catch (err) {
        console.log(`Error creating new straddle:`, err);
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
                await exitAllStraddles();
                return;
            }
        }

        // If strategy is stopped, don't check individual positions
        if (STRATEGY_STOPPED) {
            return;
        }

        // Check all active straddles for target hits
        await checkAllStraddles();

        // Check for new straddle trigger
        await checkNewStraddleTrigger();

    } catch (err) {
        console.log('Error in checkPositions:', err);
    }
}

async function checkAllStraddles() {
    try {
        let straddlesToRemove = [];

        for (let [straddleId, straddle] of straddleSystem.activeStraddles) {
            if (!straddle.isActive) continue;

            let ce_ltp = ticksCache[straddle.ce.option.instrument_token]?.last_price;
            let pe_ltp = ticksCache[straddle.pe.option.instrument_token]?.last_price;

            if (!ce_ltp || !pe_ltp) continue;

            // Update last prices
            straddle.ce.lastPrice = ce_ltp;
            straddle.pe.lastPrice = pe_ltp;
            let currentPrice = ce_ltp + pe_ltp;

            // Check for target hit
            if (currentPrice >= straddle.targetPrice) {
                console.log(`🎯 TARGET HIT for Straddle #${straddleId}! Current: ₹${currentPrice.toFixed(2)}, Target: ₹${straddle.targetPrice.toFixed(2)}`);
                await exitStraddle(straddleId);
                straddlesToRemove.push(straddleId);
            }
        }

        // Remove completed straddles
        straddlesToRemove.forEach(id => {
            straddleSystem.activeStraddles.delete(id);
        });

    } catch (err) {
        console.log('Error checking all straddles:', err);
    }
}

async function checkNewStraddleTrigger() {
    try {
        // Skip if no base price set or strategy stopped
        if (!straddleSystem.lastEntryPrice || STRATEGY_STOPPED) return;

        // Skip if we're at max straddles
        if (straddleSystem.activeStraddles.size >= MAX_STRADDLES) return;

        // Calculate current ATM straddle price for trigger comparison
        let currentATM = straddleSystem.baseATM;
        let ce_option = currentExpiryOptions[currentATM + 'CE'];
        let pe_option = currentExpiryOptions[currentATM + 'PE'];

        if (!ce_option || !pe_option) return;

        let ce_ltp = ticksCache[ce_option.instrument_token]?.last_price;
        let pe_ltp = ticksCache[pe_option.instrument_token]?.last_price;

        if (!ce_ltp || !pe_ltp) return;

        let currentStraddlePrice = ce_ltp + pe_ltp;
        let triggerPrice = straddleSystem.lastEntryPrice - NEW_TRIGGER;

        // Check if trigger condition is met
        if (currentStraddlePrice <= triggerPrice) {
            // Calculate next straddle parameters
            let nextQty = straddleSystem.activeStraddles.size + 1; // Increase quantity based on active straddles
            let nextTargetPoints = INITIAL_TARGET_POINTS + (TARGET_INCREMENT * straddleSystem.totalStraddlesCreated);

            console.log(`📉 NEW STRADDLE TRIGGER! Current: ₹${currentStraddlePrice.toFixed(2)}, Trigger: ₹${triggerPrice.toFixed(2)}`);
            console.log(`   Next Straddle: Qty=${nextQty}, Target=${nextTargetPoints} points`);

            // Create new straddle (using ATM for simplicity)
            await createNewStraddle(currentATM, 0, nextQty, nextTargetPoints);
        }

    } catch (err) {
        console.log('Error checking new straddle trigger:', err);
    }
}

async function exitStraddle(straddleId) {
    try {
        let straddle = straddleSystem.activeStraddles.get(straddleId);
        if (!straddle) return;

        // Place sell orders for both CE and PE
        await sendOrder(straddle.ce.option, 'SELL', straddle.qty, straddleId);
        await sendOrder(straddle.pe.option, 'SELL', straddle.qty, straddleId);

        // Calculate P&L
        let exitPrice = straddle.ce.lastPrice + straddle.pe.lastPrice;
        let pnl = (exitPrice - straddle.entryPrice) * straddle.qty;

        console.log(`💰 STRADDLE #${straddleId} EXITED`);
        console.log(`   Qty: ${straddle.qty} | Entry: ₹${straddle.entryPrice.toFixed(2)} | Exit: ₹${exitPrice.toFixed(2)} | P&L: ₹${pnl.toFixed(2)}`);
        console.log(`   CE Exit: ₹${straddle.ce.lastPrice} | PE Exit: ₹${straddle.pe.lastPrice}`);

        // Mark as inactive
        straddle.isActive = false;

        // Re-enter after 15 seconds delay if strategy is still active
        if (!STRATEGY_STOPPED) {
            console.log(`🔄 Scheduling re-entry for new straddle in 15 seconds...`);
            setTimeout(async () => {
                try {
                    // Don't re-enter if strategy stopped during delay
                    if (STRATEGY_STOPPED) {
                        console.log(`❌ Strategy stopped during delay - not re-entering`);
                        return;
                    }

                    // Check if we're still under max straddles limit
                    if (straddleSystem.activeStraddles.size >= MAX_STRADDLES) {
                        console.log(`⚠️ Max straddles limit reached during re-entry attempt`);
                        return;
                    }

                    let bn_quote = ticksCache[futureToken];
                    if (bn_quote) {
                        // Use the same strike as initial trade (straddleSystem.baseATM)
                        let fixedATM = straddleSystem.baseATM;

                        // Calculate new straddle parameters
                        let newQty = straddleSystem.activeStraddles.size + 1;
                        let newTargetPoints = INITIAL_TARGET_POINTS + (TARGET_INCREMENT * straddleSystem.totalStraddlesCreated);

                        console.log(`🆕 RE-ENTERING: New straddle with Qty=${newQty}, Target=${newTargetPoints} points, Fixed Strike=${fixedATM}`);
                        await createNewStraddle(fixedATM, 0, newQty, newTargetPoints);
                    } else {
                        console.log(`❌ Cannot re-enter - Future quote not available`);
                    }
                } catch (err) {
                    console.log(`Error during re-entry:`, err);
                }
            }, RE_ENTRY_DELAY); // Configurable re-entry delay
        } else {
            console.log(`⏹️ Strategy stopped - no re-entry scheduled`);
        }

    } catch (err) {
        console.log(`Error exiting straddle ${straddleId}:`, err);
    }
}

async function exitAllStraddles() {
    try {
        console.log('🚨 EXITING ALL STRADDLES - PROFIT TARGET REACHED!');

        for (let [straddleId, straddle] of straddleSystem.activeStraddles) {
            if (straddle.isActive) {
                console.log(`🔄 Exiting Straddle #${straddleId}: CE ${straddle.qty}qty, PE ${straddle.qty}qty`);
                await exitStraddle(straddleId);
            }
        }

        console.log('✅ All straddles exited. Strategy stopped permanently.');

        // Log final P&L after a short delay
        setTimeout(() => {
            let finalPNL = stoplossTracker.getPNL(ticksCache);
            console.log(`🏁 FINAL STRATEGY P&L: ₹${finalPNL.toFixed(2)}`);
        }, 2000);

    } catch (err) {
        console.log('Error exiting all straddles:', err);
    }
}

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
    console.log('\n📊 Multi Straddle Strategy Status:');
    console.log('=====================================');

    let overallPNL = 0;
    try {
        overallPNL = stoplossTracker.getPNL(ticksCache);
    } catch (err) {
        console.log('Error calculating overall P&L:', err);
    }

    let actualFuture = ticksCache[futureToken]?.last_price || 0;
    console.log(`💰 Overall P&L: ₹${overallPNL.toFixed(2)} | Target: ₹${PROFIT_TARGET} | Status: ${STRATEGY_STOPPED ? '🛑 STOPPED' : '✅ ACTIVE'}`);
    console.log(`📈 Actual Future: ${actualFuture} | Base ATM: ${straddleSystem.baseATM || 'N/A'}`);
    console.log(`📊 Active Straddles: ${straddleSystem.activeStraddles.size}/${MAX_STRADDLES} | Total Created: ${straddleSystem.totalStraddlesCreated}`);
    console.log(`🎯 Last Entry: ₹${straddleSystem.lastEntryPrice?.toFixed(2) || 'N/A'} | New Trigger: ₹${(straddleSystem.lastEntryPrice - NEW_TRIGGER)?.toFixed(2) || 'N/A'}`);

    if (straddleSystem.activeStraddles.size > 0) {
        console.log('\nActive Straddles:');
        for (let [id, straddle] of straddleSystem.activeStraddles) {
            if (straddle.isActive) {
                let currentPrice = straddle.ce.lastPrice + straddle.pe.lastPrice;
                let unrealizedPnl = (currentPrice - straddle.entryPrice) * straddle.qty;
                let timeElapsed = Math.round((new Date() - straddle.timestamp) / 1000 / 60); // minutes

                console.log(`  #${id}: Qty=${straddle.qty} | Entry=₹${straddle.entryPrice.toFixed(2)} | Current=₹${currentPrice.toFixed(2)} | Target=₹${straddle.targetPrice.toFixed(2)}`);
                console.log(`       P&L: ₹${unrealizedPnl.toFixed(2)} | Time: ${timeElapsed}m | CE: ₹${straddle.ce.lastPrice} | PE: ₹${straddle.pe.lastPrice}`);
            }
        }
    }
    console.log('=====================================\n');
}

// Configuration functions
function setInitialTargetPoints(points) {
    INITIAL_TARGET_POINTS = points;
    console.log(`Initial target points set to: ${points}`);
}

function setNewTrigger(points) {
    NEW_TRIGGER = points;
    console.log(`New straddle trigger set to: ${points}`);
}

function setTargetIncrement(points) {
    TARGET_INCREMENT = points;
    console.log(`Target increment set to: ${points} points per straddle`);
}

function setMaxStraddles(count) {
    MAX_STRADDLES = count;
    console.log(`Maximum concurrent straddles set to: ${count}`);
}

function setProfitTarget(amount) {
    PROFIT_TARGET = amount;
    console.log(`Profit target set to: ₹${amount}`);
}

function setReEntryDelay(seconds) {
    RE_ENTRY_DELAY = seconds * 1000;
    console.log(`Re-entry delay set to: ${seconds} seconds`);
}

// Export functions
module.exports = {
    setInitialTargetPoints,
    setNewTrigger,
    setTargetIncrement,
    setMaxStraddles,
    setProfitTarget,
    setReEntryDelay,
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
    // Exit all active straddles
    for (let [straddleId, straddle] of straddleSystem.activeStraddles) {
        if (straddle.isActive) {
            sendOrder(straddle.ce.option, 'SELL', straddle.qty, straddleId);
            sendOrder(straddle.pe.option, 'SELL', straddle.qty, straddleId);
        }
    }
    setTimeout(function () {
        process.exit();
    }, 5000);
}, null, true, 'Asia/Kolkata');
