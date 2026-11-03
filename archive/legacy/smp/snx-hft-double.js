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
let strategyTag = 'SNX_HFT_DBL';
let TARGET_POINTS = 10; // Initial target points
let AVERAGING_TRIGGER = 10; // Price drop trigger for averaging (10 Rs)
let TARGET_REDUCTION_PERCENT = 0; // Reduce target by 10% each new entry
let MAX_AVERAGING_STEPS = 10; // Maximum number of averaging steps allowed
let CALL_STRIKE_OFFSETS = [100]; // Multiple call strike offsets from ATM
let PUT_STRIKE_OFFSETS = [-100]; // Multiple put strike offsets from ATM
let PROFIT_TARGET = 100000000; // Exit all positions when profit reaches this amount
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
        console.log('HFT Double Quantity Strategy - Live Feed Connected');
        liveFeed.subscribe(subs);
        liveFeed.setMode(liveFeed.modeFull, subs);
    });
}
let futureToken,
    currentExpiryOptions = {};

// Position tracking for multiple CE and PE strikes
let positions = {
    // Will be dynamically populated based on strike offsets
    // Format: "CE_50", "CE_100", "PE_-50", "PE_-100", etc.
};

async function runStrategy() {
    try {
        let optionData = await optionConfig('SENSEX');
        futureToken = 265;
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
    // Initialize CE positions for all call strike offsets
    CALL_STRIKE_OFFSETS.forEach(offset => {
        let positionKey = `CE_${offset}`;
        positions[positionKey] = {
            entries: [],
            totalQty: 0,
            totalCost: 0,
            avgPrice: 0,
            currentTarget: TARGET_POINTS,
            isActive: false,
            option: null,
            lastPrice: 0,
            strike: 0,
            strikeOffset: offset,
            optionType: 'CE'
        };
    });

    // Initialize PE positions for all put strike offsets
    PUT_STRIKE_OFFSETS.forEach(offset => {
        let positionKey = `PE_${Math.abs(offset)}`;
        positions[positionKey] = {
            entries: [],
            totalQty: 0,
            totalCost: 0,
            avgPrice: 0,
            currentTarget: TARGET_POINTS,
            isActive: false,
            option: null,
            lastPrice: 0,
            strike: 0,
            strikeOffset: offset,
            optionType: 'PE'
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
        console.log(`Starting HFT Double Quantity Strategy at ATM: ${atm}`);
        console.log(`Call Strike Offsets: [${CALL_STRIKE_OFFSETS.join(', ')}]`);
        console.log(`Put Strike Offsets: [${PUT_STRIKE_OFFSETS.join(', ')}]`);

        // Take initial positions for all CE strikes
        for (let offset of CALL_STRIKE_OFFSETS) {
            await takeInitialPosition(atm, offset, 'CE');
        }

        // Take initial positions for all PE strikes
        for (let offset of PUT_STRIKE_OFFSETS) {
            await takeInitialPosition(atm, offset, 'PE');
        }
    } catch (err) {
        console.log('Error in startInitialTrades:', err);
    }
}

async function takeInitialPosition(atm, strikeOffset, optionType) {
    try {
        // Don't take new positions if strategy is stopped
        if (STRATEGY_STOPPED) {
            console.log(`❌ Strategy stopped - not taking new ${optionType}_${Math.abs(strikeOffset)} position`);
            return;
        }

        let strike = atm + strikeOffset;
        let option = currentExpiryOptions[strike + optionType];

        if (!option) {
            console.log(`${optionType} option not found for strike ${strike} (offset: ${strikeOffset})`);
            return;
        }

        let ltp = ticksCache[option.instrument_token]?.last_price;

        if (!ltp) {
            console.log(`LTP not available for ${optionType} ${strike}`);
            return;
        }

        // Get position key
        let positionKey = `${optionType}_${Math.abs(strikeOffset)}`;
        let position = positions[positionKey];

        // Set option references
        position.option = option;
        position.lastPrice = ltp;
        position.strike = strike;

        // Take initial position with quantity 1
        await addEntry(positionKey, ltp, 1, true);

        console.log(`Initial ${positionKey} position taken: ${option.tradingsymbol} @ ₹${ltp}`);
    } catch (err) {
        console.log(`Error taking initial ${optionType}_${Math.abs(strikeOffset)} position:`, err);
    }
}

async function addEntry(positionKey, price, qty, isInitial = false) {
    try {
        // Don't add new entries if strategy is stopped
        if (STRATEGY_STOPPED) {
            console.log(`❌ Strategy stopped - not adding new ${positionKey} entry`);
            return;
        }

        let position = positions[positionKey];

        // Add new entry
        position.entries.push({
            price: price,
            qty: qty,
            timestamp: new Date()
        });

        // Update totals
        position.totalQty += qty;
        position.totalCost += price * qty;
        position.avgPrice = position.totalCost / position.totalQty;
        position.isActive = true;

        // Reduce target by configured percentage for non-initial entries
        if (!isInitial && position.entries.length > 1) {
            position.currentTarget = position.currentTarget * (1 - TARGET_REDUCTION_PERCENT / 100);
            console.log(`📉 ${positionKey} Target reduced to: ₹${position.currentTarget.toFixed(2)} (${TARGET_REDUCTION_PERCENT}% reduction)`);
        }

        // Place buy order
        await sendOrder(position.option, 'BUY', qty);

        console.log(`${positionKey} - Added entry: Qty=${qty}, Price=₹${price}, AvgPrice=₹${position.avgPrice.toFixed(2)}, TotalQty=${position.totalQty}, Target=₹${position.currentTarget.toFixed(2)}`);
    } catch (err) {
        console.log(`Error adding ${positionKey} entry:`, err);
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

        // Check CE and PE positions separately
        for (let positionKey in positions) {
            await checkOptionPosition(positionKey);
        }
    } catch (err) {
        console.log('Error in checkPositions:', err);
    }
}

async function checkOptionPosition(positionKey) {
    try {
        let position = positions[positionKey];

        if (!position.isActive) return;

        let ltp = ticksCache[position.option.instrument_token]?.last_price;
        if (!ltp) return;

        // Update last price
        position.lastPrice = ltp;

        // Check for target hit (average price + dynamic target)
        let targetPrice = position.avgPrice + position.currentTarget;
        if (ltp >= targetPrice) {
            console.log(`🎯 ${positionKey} TARGET HIT! Current: ₹${ltp.toFixed(2)}, Target: ₹${targetPrice.toFixed(2)}`);
            await squareOffPosition(positionKey);
            return;
        }

        // Check for averaging opportunity (price dropped by AVERAGING_TRIGGER from average)
        let avgTriggerPrice = position.avgPrice - AVERAGING_TRIGGER;
        if (ltp <= avgTriggerPrice) {
            // Calculate next quantity (double the last entry quantity)
            let lastEntry = position.entries[position.entries.length - 1];
            let nextQty = lastEntry ? lastEntry.qty * 2 : 1; // Double last qty, or start with 1 if no entries

            // Check max averaging steps limit
            if (position.entries.length >= MAX_AVERAGING_STEPS) {
                // console.log(`⚠️ MAX AVERAGING STEPS REACHED for ${positionKey}! Current steps: ${position.entries.length}, Max: ${MAX_AVERAGING_STEPS}`);
                // console.log(`   No more averaging allowed, waiting for target or manual intervention...`);
                return;
            }

            console.log(`📉 ${positionKey} Averaging trigger! Current: ₹${ltp.toFixed(2)}, Trigger: ₹${avgTriggerPrice.toFixed(2)}, Next Qty: ${nextQty} (doubled from ${lastEntry?.qty || 0}), Step: ${position.entries.length + 1}/${MAX_AVERAGING_STEPS}`);
            await addEntry(positionKey, ltp, nextQty, false);
        }
    } catch (err) {
        console.log(`Error checking ${positionKey} position:`, err);
    }
}

async function squareOffPosition(positionKey) {
    try {
        let position = positions[positionKey];

        // Place sell order to square off
        await sendOrder(position.option, 'SELL', position.totalQty);

        // Calculate P&L
        let pnl = (position.lastPrice - position.avgPrice) * position.totalQty;

        console.log(`💰 ${positionKey} Position squared off`);
        console.log(`   Total Qty: ${position.totalQty}, Avg Price: ₹${position.avgPrice.toFixed(2)}, Exit Price: ₹${position.lastPrice.toFixed(2)}, P&L: ₹${pnl.toFixed(2)}`);

        // Reset position
        position.entries = [];
        position.totalQty = 0;
        position.totalCost = 0;
        position.avgPrice = 0;
        position.currentTarget = TARGET_POINTS; // Reset target to initial value
        position.isActive = false;

        console.log(`✅ ${positionKey} position completed. Restarting in 10 seconds...`);

        // Restart this position after 10 seconds
        setTimeout(async () => {
            try {
                // Don't restart if strategy is stopped
                if (STRATEGY_STOPPED) {
                    console.log(`❌ Strategy stopped - not restarting ${positionKey} position`);
                    return;
                }

                let bn_quote = ticksCache[futureToken];
                if (bn_quote) {
                    let atm = Math.round(bn_quote.last_price / 100) * 100;
                    console.log(`🔄 Restarting ${positionKey} position after 10s delay...`);
                    await takeInitialPosition(atm, position.strikeOffset, position.optionType);
                } else {
                    console.log(`❌ Cannot restart ${positionKey} - Future quote not available`);
                }
            } catch (err) {
                console.log(`Error restarting ${positionKey}:`, err);
            }
        }, 10000);
    } catch (err) {
        console.log(`Error squaring off ${positionKey} position:`, err);
    }
}

// Function to exit all positions at cost when profit target is reached
async function exitAllPositionsAtCost() {
    try {
        console.log('🚨 EXITING ALL POSITIONS AT COST - PROFIT TARGET REACHED!');
        
        for (let positionKey in positions) {
            let position = positions[positionKey];
            if (position.isActive && position.totalQty > 0) {
                console.log(`🔄 Exiting ${positionKey} position: ${position.totalQty}qty`);
                
                // Square off position
                await sendOrder(position.option, 'SELL', position.totalQty);
                
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
        
        // Paper trade tracking
        PaperTrade.trackOrder(option, transType, strategyTag, qty);
        console.log(`📋 ${transType} order placed for ${option.tradingsymbol} (Qty: ${qty}) @ ₹${price}`);
    } catch (err) {
        console.log('Error placing order:', err);
    }
}

// Status reporting function
function getStrategyStatus() {
    console.log('\n📊 HFT Double Quantity Strategy Status:');
    console.log('=====================================');
    
    // Show overall P&L and strategy status
    let overallPNL = 0;
    try {
        overallPNL = stoplossTracker.getPNL(ticksCache);
    } catch (err) {
        console.log('Error calculating overall P&L:', err);
    }
    
    console.log(`💰 Overall P&L: ₹${overallPNL.toFixed(2)} | Target: ₹${PROFIT_TARGET} | Status: ${STRATEGY_STOPPED ? '🛑 STOPPED' : '✅ ACTIVE'}`);
    console.log(`📊 Call Strike Offsets: [${CALL_STRIKE_OFFSETS.join(', ')}] | Put Strike Offsets: [${PUT_STRIKE_OFFSETS.join(', ')}]`);

    for (let positionKey in positions) {
        console.log(`\n${positionKey}:`);

        let pos = positions[positionKey];
        if (pos.isActive) {
            let targetPrice = pos.avgPrice + pos.currentTarget;
            let triggerPrice = pos.avgPrice - AVERAGING_TRIGGER;
            let maxStepsReached = pos.entries.length >= MAX_AVERAGING_STEPS;

            // Show quantity progression
            let qtyProgression = pos.entries.map(entry => entry.qty).join(' → ');
            let nextQty = pos.entries.length > 0 ? pos.entries[pos.entries.length - 1].qty * 2 : 1;

            console.log(`  Status: Active | Strike: ${pos.strike} | Qty: ${pos.totalQty} | Avg: ₹${pos.avgPrice.toFixed(2)} | Current: ₹${pos.lastPrice.toFixed(2)}`);
            console.log(`  Steps: ${pos.entries.length}/${MAX_AVERAGING_STEPS} | Qty Progression: ${qtyProgression} | Next: ${nextQty}`);
            console.log(`  Target: ₹${targetPrice.toFixed(2)} (${pos.currentTarget.toFixed(2)} pts) | Trigger: ₹${triggerPrice.toFixed(2)}${maxStepsReached ? ' | MAX STEPS REACHED!' : ''}`);
        } else {
            console.log(`  Status: Inactive`);
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

function setCallStrikeOffsets(offsets) {
    CALL_STRIKE_OFFSETS = offsets;
    console.log(`Call strike offsets set to: [${offsets.join(', ')}]`);
}

function setPutStrikeOffsets(offsets) {
    PUT_STRIKE_OFFSETS = offsets;
    console.log(`Put strike offsets set to: [${offsets.join(', ')}]`);
}

function setProfitTarget(target) {
    PROFIT_TARGET = target;
    console.log(`Profit target set to: ₹${target}`);
}

// Export functions
module.exports = {
    setTargetPoints,
    setAveragingTrigger,
    setTargetReduction,
    setMaxAveragingSteps,
    setCallStrikeOffsets,
    setPutStrikeOffsets,
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
  // Square off all active positions
  for (let positionKey in positions) {
    if (positions[positionKey].isActive) {
      sendOrder(positions[positionKey].option, 'SELL', positions[positionKey].totalQty);
    }
  }
  setTimeout(function () {
    process.exit();
  }, 5000);
}, null, true, 'Asia/Kolkata');
