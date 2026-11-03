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
let strategyTag = 'NF_HFT_AVG';
let TARGET_POINTS = 5; // Initial target points
let AVERAGING_TRIGGER = 2; // Price drop trigger for averaging (5 Rs)
let TARGET_REDUCTION_PERCENT = 0; // Reduce target by 10% each new entry
let MAX_AVERAGING_STEPS = 1; // Maximum number of averaging steps allowed
let STRIKES = [0];
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
        console.log('HFT Averaging Strategy - Live Feed Connected');
        liveFeed.subscribe(subs);
        liveFeed.setMode(liveFeed.modeFull, subs);
    });
}
let futureToken,
    currentExpiryOptions = {};

// Position tracking for each strike (pair-based)
let positions = {
    // Format: strikeKey: { 
    //   entries: [], totalQty, totalCost, avgPrice, isActive,
    //   ce: { option, lastPrice }, pe: { option, lastPrice }
    // }
};

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

        // Initialize positions for all strikes
        initializePositions();

        setTimeout(() => { startInitialTrades(); }, 5000);
    } catch (err) {
        console.log('Error in runStrategy:', err);
    }
}

function initializePositions() {
    STRIKES.forEach(strike => {
        let strikeKey = strike === 0 ? 'ATM' : (strike > 0 ? `P${strike}` : `M${Math.abs(strike)}`);
        positions[strikeKey] = {
            entries: [],
            totalQty: 0,
            totalCost: 0,
            avgPrice: 0,
            currentTarget: TARGET_POINTS, // Dynamic target that reduces with each entry
            isActive: false,
            ce: {
                option: null,
                lastPrice: 0
            },
            pe: {
                option: null,
                lastPrice: 0
            }
        };
    });
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

async function startInitialTrades() {
    try {
        let bn_quote = ticksCache[futureToken];
        if (!bn_quote) {
            console.log('Future quote not available yet');
            setTimeout(() => startInitialTrades(), 1000);
            return;
        }

        let atm = Math.round(bn_quote.last_price / 100) * 100;
        console.log(`Starting HFT Averaging Strategy at ATM: ${atm}`);

        // Take initial positions for all strikes
        for (let strike of STRIKES) {
            await takeInitialPosition(atm, strike);
        }
    } catch (err) {
        console.log('Error in startInitialTrades:', err);
    }
}

async function takeInitialPosition(atm, strikeOffset) {
    try {
        // Don't take new positions if strategy is stopped
        if (STRATEGY_STOPPED) {
            console.log(`❌ Strategy stopped - not taking new position for strike offset ${strikeOffset}`);
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

        let strikeKey = strikeOffset === 0 ? 'ATM' : (strikeOffset > 0 ? `P${strikeOffset}` : `M${Math.abs(strikeOffset)}`);

        // Set option references
        positions[strikeKey].ce.option = ce_option;
        positions[strikeKey].pe.option = pe_option;
        positions[strikeKey].ce.lastPrice = ce_ltp;
        positions[strikeKey].pe.lastPrice = pe_ltp;

        // Take initial pair position with quantity 1
        await addPairEntry(strikeKey, ce_ltp, pe_ltp, 1, true);

        console.log(`Initial pair position taken for ${strikeKey}: CE@${ce_ltp}, PE@${pe_ltp}, Pair@${ce_ltp + pe_ltp}`);
    } catch (err) {
        console.log(`Error taking initial position for strike ${strikeOffset}:`, err);
    }
}

async function addPairEntry(strikeKey, cePrice, pePrice, qty, isInitial = false) {
    try {
        // Don't add new entries if strategy is stopped
        if (STRATEGY_STOPPED) {
            console.log(`❌ Strategy stopped - not adding new entry for ${strikeKey}`);
            return;
        }

        let position = positions[strikeKey];
        let pairPrice = cePrice + pePrice;

        // Add new entry
        position.entries.push({
            cePrice: cePrice,
            pePrice: pePrice,
            pairPrice: pairPrice,
            qty: qty,
            timestamp: new Date()
        });

        // Update totals
        position.totalQty += qty;
        position.totalCost += pairPrice * qty;
        position.avgPrice = position.totalCost / position.totalQty;
        position.isActive = true;

        // Reduce target by 10% for non-initial entries
        if (!isInitial && position.entries.length > 1) {
            position.currentTarget = position.currentTarget * (1 - TARGET_REDUCTION_PERCENT / 100);
            console.log(`📉 Target reduced to: ${position.currentTarget.toFixed(2)} (${TARGET_REDUCTION_PERCENT}% reduction)`);
        }

        // Place buy orders for both CE and PE
        await sendOrder(position.ce.option, 'BUY', qty);
        await sendOrder(position.pe.option, 'BUY', qty);

        console.log(`${strikeKey} PAIR - Added entry: Qty=${qty}, CE=${cePrice}, PE=${pePrice}, PairPrice=${pairPrice}, AvgPrice=${position.avgPrice.toFixed(2)}, TotalQty=${position.totalQty}, Target=${position.currentTarget.toFixed(2)}`);
    } catch (err) {
        console.log(`Error adding pair entry for ${strikeKey}:`, err);
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
                await exitAllPositionsAtCost();
                return;
            }
        }

        // If strategy is stopped, don't check individual positions
        if (STRATEGY_STOPPED) {
            return;
        }

        for (let strikeKey in positions) {
            await checkStrikePosition(strikeKey);
        }
    } catch (err) {
        console.log('Error in checkPositions:', err);
    }
}

async function checkStrikePosition(strikeKey) {
    try {
        let position = positions[strikeKey];

        // Check pair position if active
        if (position.isActive) {
            await checkPairPosition(strikeKey);
        }
    } catch (err) {
        console.log(`Error checking position for ${strikeKey}:`, err);
    }
}

async function checkPairPosition(strikeKey) {
    try {
        let position = positions[strikeKey];
        let ce_ltp = ticksCache[position.ce.option.instrument_token]?.last_price;
        let pe_ltp = ticksCache[position.pe.option.instrument_token]?.last_price;

        if (!ce_ltp || !pe_ltp) return;

        // Update last prices
        position.ce.lastPrice = ce_ltp;
        position.pe.lastPrice = pe_ltp;
        let currentPairPrice = ce_ltp + pe_ltp;

        // Check for target hit (average pair price + dynamic target)
        let targetPrice = position.avgPrice + position.currentTarget;
        if (currentPairPrice >= targetPrice) {
            console.log(`🎯 PAIR TARGET HIT for ${strikeKey}! Current: ${currentPairPrice.toFixed(2)}, Target: ${targetPrice.toFixed(2)}`);
            await squareOffPair(strikeKey);
            return;
        }

        // Check for averaging opportunity (pair price dropped by AVERAGING_TRIGGER from average)
        let avgTriggerPrice = position.avgPrice - AVERAGING_TRIGGER;
        if (currentPairPrice <= avgTriggerPrice) {
            // Calculate next quantity (increase by 1 for each averaging)
            let nextQty = position.entries.length + 1;

            // Check max averaging steps limit (total entries including initial)
            if (position.entries.length >= MAX_AVERAGING_STEPS) {
                // console.log(`⚠️ MAX AVERAGING STEPS REACHED for ${strikeKey}! Current steps: ${position.entries.length}, Max: ${MAX_AVERAGING_STEPS}`);
                // console.log(`   No more averaging allowed, waiting for target or manual intervention...`);
                return;
            }

            console.log(`📉 PAIR Averaging trigger for ${strikeKey}! Current: ${currentPairPrice.toFixed(2)}, Trigger: ${avgTriggerPrice.toFixed(2)}, Next Qty: ${nextQty}, Step: ${position.entries.length + 1}/${MAX_AVERAGING_STEPS}`);
            await addPairEntry(strikeKey, ce_ltp, pe_ltp, nextQty, false);
        }
    } catch (err) {
        console.log(`Error checking pair position for ${strikeKey}:`, err);
    }
}

async function squareOffPair(strikeKey) {
    try {
        let position = positions[strikeKey];

        // Place sell orders for both CE and PE to square off
        await sendOrder(position.ce.option, 'SELL', position.totalQty);
        await sendOrder(position.pe.option, 'SELL', position.totalQty);

        // Calculate P&L (profit when current pair price > avg pair price)
        let currentPairPrice = position.ce.lastPrice + position.pe.lastPrice;
        let pnl = (currentPairPrice - position.avgPrice) * position.totalQty;

        console.log(`💰 PAIR Position squared off for ${strikeKey}`);
        console.log(`   Total Qty: ${position.totalQty}, Avg Pair Price: ${position.avgPrice.toFixed(2)}, Exit Pair Price: ${currentPairPrice.toFixed(2)}, P&L: ${pnl.toFixed(2)}`);
        console.log(`   CE: ${position.ce.lastPrice}, PE: ${position.pe.lastPrice}`);

        // Reset position
        position.entries = [];
        position.totalQty = 0;
        position.totalCost = 0;
        position.avgPrice = 0;
        position.currentTarget = TARGET_POINTS; // Reset target to initial value
        position.isActive = false;

        console.log(`✅ Pair position completed for ${strikeKey}. Restarting in 10 seconds...`);

        // Restart this strike after 10 seconds
        setTimeout(async () => {
            try {
                // Don't restart if strategy is stopped
                if (STRATEGY_STOPPED) {
                    console.log(`❌ Strategy stopped - not restarting ${strikeKey} position`);
                    return;
                }

                let bn_quote = ticksCache[futureToken];
                if (bn_quote) {
                    let atm = Math.round(bn_quote.last_price / 100) * 100;
                    let strikeOffset = getStrikeOffset(strikeKey, atm);
                    console.log(`🔄 Restarting ${strikeKey} position after 10s delay...`);
                    await takeInitialPosition(atm, strikeOffset);
                } else {
                    console.log(`❌ Cannot restart ${strikeKey} - Future quote not available`);
                }
            } catch (err) {
                console.log(`Error restarting ${strikeKey}:`, err);
            }
        }, 10000);
    } catch (err) {
        console.log(`Error squaring off pair position for ${strikeKey}:`, err);
    }
}

// Helper function to get strike offset from strike key
function getStrikeOffset(strikeKey, currentATM) {
    if (strikeKey === 'ATM') return 0;
    if (strikeKey.startsWith('P')) return parseInt(strikeKey.substring(1));
    if (strikeKey.startsWith('M')) return -parseInt(strikeKey.substring(1));
    return 0;
}

// Function to exit all positions at cost when profit target is reached
async function exitAllPositionsAtCost() {
    try {
        console.log('🚨 EXITING ALL POSITIONS AT COST - PROFIT TARGET REACHED!');
        
        for (let strikeKey in positions) {
            let position = positions[strikeKey];
            if (position.isActive && position.totalQty > 0) {
                console.log(`🔄 Exiting ${strikeKey} position: CE ${position.totalQty}qty, PE ${position.totalQty}qty`);
                
                // Square off both CE and PE positions
                await sendOrder(position.ce.option, 'SELL', position.totalQty);
                await sendOrder(position.pe.option, 'SELL', position.totalQty);
                
                // Reset position
                position.entries = [];
                position.totalQty = 0;
                position.totalCost = 0;
                position.avgPrice = 0;
                position.currentTarget = TARGET_POINTS;
                position.isActive = false;
            }
        }
        
        console.log('✅ All positions exited. Strategy stopped permanently.');
        
        // Log final P&L after a short delay to allow orders to process
        setTimeout(() => {
            let finalPNL = stoplossTracker.getPNL(ticksCache);
            console.log(`🏁 FINAL STRATEGY P&L: ₹${finalPNL.toFixed(2)}`);
        }, 2000);
        
    } catch (err) {
        console.log('Error exiting all positions:', err);
    }
}

var checkPositionsQ = async.queue(function (task, callback) {
    checkPositions().then(function (res) {
        callback();
    });
}, 1);

async function sendOrder(option, transType, qty = 1) {
    try {
        // Get current price for the order
        let price = ticksCache[option.instrument_token]?.last_price || 0;
        
        // Track order in stoploss tracker for P&L calculation
        stoplossTracker.addOrder(option, price, transType, qty);
        
        // Paper trade tracking - place single order with correct quantity
        PaperTrade.trackOrder(option, transType, strategyTag, qty);
        console.log(`📋 ${transType} order placed for ${option.tradingsymbol} (Qty: ${qty}) @ ₹${price}`);
    } catch (err) {
        console.log('Error placing order:', err);
    }
}

// Status reporting function
function getStrategyStatus() {
    console.log('\n📊 HFT Pair Averaging Strategy Status:');
    console.log('=====================================');
    
    // Show overall P&L and strategy status
    let overallPNL = 0;
    try {
        overallPNL = stoplossTracker.getPNL(ticksCache);
    } catch (err) {
        console.log('Error calculating overall P&L:', err);
    }
    
    console.log(`💰 Overall P&L: ₹${overallPNL.toFixed(2)} | Target: ₹${PROFIT_TARGET} | Status: ${STRATEGY_STOPPED ? '🛑 STOPPED' : '✅ ACTIVE'}`);

    for (let strikeKey in positions) {
        console.log(`\n${strikeKey}:`);

        let pos = positions[strikeKey];
        if (pos.isActive) {
            let currentPairPrice = pos.ce.lastPrice + pos.pe.lastPrice;
            let targetPrice = pos.avgPrice + pos.currentTarget;
            let triggerPrice = pos.avgPrice - AVERAGING_TRIGGER;
            let maxStepsReached = pos.entries.length >= MAX_AVERAGING_STEPS;

            console.log(`  PAIR: Active | Qty: ${pos.totalQty} | Avg: ₹${pos.avgPrice.toFixed(2)} | Current: ₹${currentPairPrice.toFixed(2)} | Steps: ${pos.entries.length}/${MAX_AVERAGING_STEPS}`);
            console.log(`        Target: ₹${targetPrice.toFixed(2)} (${pos.currentTarget.toFixed(2)} pts) | Trigger: ₹${triggerPrice.toFixed(2)}${maxStepsReached ? ' | MAX STEPS REACHED!' : ''}`);
            console.log(`        CE: ₹${pos.ce.lastPrice} | PE: ₹${pos.pe.lastPrice}`);
        } else {
            console.log(`  PAIR: Inactive`);
        }
    }
    console.log('=====================================\n');
}

// Configuration functions
function setTargetPoints(points) {
    TARGET_POINTS = points;
    console.log(`Target points set to: ${points}`);
}

function setAveragingTrigger(points) {
    AVERAGING_TRIGGER = points;
    console.log(`Averaging trigger set to: ${points}`);
}

function setTargetReduction(percent) {
    TARGET_REDUCTION_PERCENT = percent;
    console.log(`Target reduction percentage set to: ${percent}%`);
}

function setMaxAveragingSteps(steps) {
    MAX_AVERAGING_STEPS = steps;
    console.log(`Maximum averaging steps set to: ${steps}`);
}

// Export functions
module.exports = {
    setTargetPoints,
    setAveragingTrigger,
    setTargetReduction,
    setMaxAveragingSteps,
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
  // Square off all active positions
  for (let strikeKey in positions) {
    if (positions[strikeKey].isActive) {
      sendOrder(positions[strikeKey].ce.option, 'SELL', positions[strikeKey].totalQty);
      sendOrder(positions[strikeKey].pe.option, 'SELL', positions[strikeKey].totalQty);
    }
  }
  setTimeout(function () {
    process.exit();
  }, 5000);
}, null, true, 'Asia/Kolkata');
