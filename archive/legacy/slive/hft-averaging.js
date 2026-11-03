const CronJob = require("cron").CronJob;
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const kiteTicker = require('../lib/KiteTicker');
const Account = app.models.account;
const PaperTrade = app.models.PaperTrade;
const XtsAccount = app.models.xtsAccount;
const optionConfig = require('../tools/optionInstruments');
const async = require('async');
const Stoploss = require('../tools/stoploss.js');

// Strategy Config
let strategyTag = 'SNX_HFT_AVG';
let TARGET_POINTS = 10; // Initial target points
let AVERAGING_TRIGGER = 10; // Price drop trigger for averaging (5 Rs)
let TARGET_REDUCTION_PERCENT = 0; // Reduce target by 10% each new entry
let MAX_AVERAGING_STEPS = 1; // Maximum number of averaging steps allowed
let STRIKES = [0];
let PROFIT_TARGET = 3000000; // Exit all positions when profit reaches this amount
let STRATEGY_STOPPED = false; // Flag to stop strategy when profit target is reached

// Event tracking for order management
let eventIdx = 0;
const eventId = () => (eventIdx++);
let eventTrigger = {};

// Initialize Stoploss tracker for overall P&L
let stoplossTracker = new Stoploss();

let public_token;

// Order fill tracking system - similar to cp-s-2040.js
PaperTrade.getDataSource().connector.connect(function (err, db) {
    console.log('OrderUpdate datasource connected for HFT strategy');
    const collection2 = db.collection("OrderUpdate");
    const changeStream2 = collection2.watch();
    changeStream2.on("change", function (event) {
        try {
            if (event.operationType == 'insert') {
                let update = event.fullDocument;
                if (update.updateType == 'order' && update.strategy == strategyTag) {
                    if (update.params && update.params.length > 0) {
                        let eventTrgIdx = update.params[0];
                        handleOrderFill(eventTrgIdx, update);
                    }
                }
            }
        } catch (err) {
            console.log('Error in order update handler:', err);
        }
    });
});

async function handleOrderFill(eventTrgIdx, update) {
    try {
        if (eventTrigger[eventTrgIdx] && update.status == 'Filled') {
            let fillPrice = parseFloat(update.price);
            let eventData = eventTrigger[eventTrgIdx];
            
            console.log(`📋 Order filled: ${eventData.instrument.tradingsymbol} ${eventData.transType} @ ₹${fillPrice} (Event ID: ${eventTrgIdx})`);
            
            if (eventData.action === 'buy_entry' || eventData.action === 'buy_averaging') {
                await updatePositionWithFillPrice(eventData.strikeKey, eventData.optionType, fillPrice, eventData.qty, eventData.isInitial);
            } else if (eventData.action === 'sell_exit') {
                await updateExitWithFillPrice(eventData.strikeKey, eventData.optionType, fillPrice, eventData.qty);
            }
            
            // Clean up event trigger
            eventTrigger[eventTrgIdx] = false;
        }
    } catch (err) {
        console.log('Error handling order fill:', err);
    }
}

async function updatePositionWithFillPrice(strikeKey, optionType, fillPrice, qty, isInitial = false) {
    try {
        let position = positions[strikeKey];
        if (!position) return;
        
        // Find the latest entry that needs to be updated
        let latestEntry = position.entries[position.entries.length - 1];
        if (!latestEntry || latestEntry.fillPriceUpdated) return;
        
        let estimatedPrice = 0;
        let priceDifference = 0;
        
        // Update the entry with actual fill price and calculate difference
        if (optionType === 'CE') {
            estimatedPrice = latestEntry.estimatedCEPrice;
            priceDifference = fillPrice - estimatedPrice;
            latestEntry.cePrice = fillPrice;
            latestEntry.ceFilled = true;
            
            console.log(`📋 CE Fill for ${strikeKey}: Est ₹${estimatedPrice} → Fill ₹${fillPrice} (Diff: ${priceDifference >= 0 ? '+' : ''}₹${priceDifference.toFixed(2)})`);
        } else if (optionType === 'PE') {
            estimatedPrice = latestEntry.estimatedPEPrice;
            priceDifference = fillPrice - estimatedPrice;
            latestEntry.pePrice = fillPrice;
            latestEntry.peFilled = true;
            
            console.log(`📋 PE Fill for ${strikeKey}: Est ₹${estimatedPrice} → Fill ₹${fillPrice} (Diff: ${priceDifference >= 0 ? '+' : ''}₹${priceDifference.toFixed(2)})`);
        }
        
        // Update position immediately with the price difference for this leg
        if (priceDifference !== 0) {
            position.totalCost += priceDifference * qty;
            position.avgPrice = position.totalCost / position.totalQty;
            console.log(`📊 ${strikeKey} Avg Price updated: ₹${position.avgPrice.toFixed(2)} (Adjusted by ₹${(priceDifference * qty).toFixed(2)} total cost)`);
        }
        
        // Check if both CE and PE are filled for this entry
        if (latestEntry.ceFilled && latestEntry.peFilled) {
            latestEntry.pairPrice = latestEntry.cePrice + latestEntry.pePrice;
            latestEntry.fillPriceUpdated = true;
            
            // Final recalculation to ensure accuracy
            recalculatePosition(strikeKey);
            
            console.log(`✅ Entry completed with fill prices for ${strikeKey}: CE@${latestEntry.cePrice}, PE@${latestEntry.pePrice}, Pair@${latestEntry.pairPrice}`);
        }
        
    } catch (err) {
        console.log('Error updating position with fill price:', err);
    }
}

async function updateExitWithFillPrice(strikeKey, optionType, fillPrice, qty) {
    try {
        let position = positions[strikeKey];
        if (!position || !position.exitInProgress) return;
        
        // Update exit prices
        if (optionType === 'CE') {
            position.exitCEPrice = fillPrice;
            position.ceExitFilled = true;
        } else if (optionType === 'PE') {
            position.exitPEPrice = fillPrice;
            position.peExitFilled = true;
        }
        
        // Check if both CE and PE exits are filled
        if (position.ceExitFilled && position.peExitFilled) {
            let exitPairPrice = position.exitCEPrice + position.exitPEPrice;
            let pnl = (exitPairPrice - position.avgPrice) * position.totalQty;
            
            console.log(`💰 PAIR Position squared off for ${strikeKey} with ACTUAL fill prices`);
            console.log(`   Total Qty: ${position.totalQty}, Avg Pair Price: ${position.avgPrice.toFixed(2)}, Exit Pair Price: ${exitPairPrice.toFixed(2)}, P&L: ${pnl.toFixed(2)}`);
            console.log(`   CE Exit Fill: ₹${position.exitCEPrice}, PE Exit Fill: ₹${position.exitPEPrice}`);
            
            // Reset position
            resetPosition(strikeKey);
            
            // Restart this strike after 10 seconds
            setTimeout(async () => {
                if (!STRATEGY_STOPPED) {
                    let bn_quote = ticksCache[futureToken];
                    if (bn_quote) {
                        let syntheticATM = await calculateSyntheticATM();
                        let strikeOffset = getStrikeOffset(strikeKey, syntheticATM);
                        console.log(`🔄 Restarting ${strikeKey} position after 10s delay using synthetic ATM: ${syntheticATM}...`);
                        await takeInitialPosition(syntheticATM, strikeOffset);
                    }
                }
            }, 10000);
        }
        
    } catch (err) {
        console.log('Error updating exit with fill price:', err);
    }
}

function recalculatePosition(strikeKey) {
    try {
        let position = positions[strikeKey];
        if (!position) return;
        
        // Recalculate totals based on actual fill prices
        position.totalCost = 0;
        position.totalQty = 0;
        
        for (let entry of position.entries) {
            if (entry.fillPriceUpdated) {
                position.totalCost += entry.pairPrice * entry.qty;
                position.totalQty += entry.qty;
            }
        }
        
        if (position.totalQty > 0) {
            position.avgPrice = position.totalCost / position.totalQty;
            console.log(`📊 Position recalculated for ${strikeKey}: Avg Price: ₹${position.avgPrice.toFixed(2)}, Total Qty: ${position.totalQty}, Total Cost: ₹${position.totalCost.toFixed(2)}`);
        }
        
    } catch (err) {
        console.log('Error recalculating position:', err);
    }
}

function resetPosition(strikeKey) {
    let position = positions[strikeKey];
    position.entries = [];
    position.totalQty = 0;
    position.totalCost = 0;
    position.avgPrice = 0;
    position.currentTarget = TARGET_POINTS;
    position.isActive = false;
    position.exitInProgress = false;
    position.exitCEPrice = 0;
    position.exitPEPrice = 0;
    position.ceExitFilled = false;
    position.peExitFilled = false;
}

async function cancelPendingOrders() {
    try {
        let masterId = app.get('masterId');
        XtsAccount.removePending(masterId, strategyTag, function (err, res) {
            if (err) {
                console.log('Error removing pending orders:', err);
            } else {
                console.log('Pending orders cancelled:', res);
            }
        });
    } catch (err) {
        console.log('Error in cancelPendingOrders:', err);
    }
}

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
    //   ce: { option, lastPrice }, pe: { option, lastPrice },
    //   exitInProgress: false, exitCEPrice: 0, exitPEPrice: 0,
    //   ceExitFilled: false, peExitFilled: false
    // }
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
    STRIKES.forEach(strike => {
        let strikeKey = strike === 0 ? 'ATM' : (strike > 0 ? `P${strike}` : `M${Math.abs(strike)}`);
        positions[strikeKey] = {
            entries: [],
            totalQty: 0,
            totalCost: 0,
            avgPrice: 0,
            currentTarget: TARGET_POINTS, // Dynamic target that reduces with each entry
            isActive: false,
            exitInProgress: false,
            exitCEPrice: 0,
            exitPEPrice: 0,
            ceExitFilled: false,
            peExitFilled: false,
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

// Helper function to get ask price (for entry/tracking) - 3rd ask price
function getAskPrice(token) {
    let tick = ticksCache[token];
    if (!tick || !tick.depth || !tick.depth.sell || tick.depth.sell.length < 3) {
        return tick?.last_price || 0;
    }
    return tick.depth.sell[2].price; // 3rd ask price (index 2)
}

// Helper function to get bid price (for exit at target) - 3rd bid price
function getBidPrice(token) {
    let tick = ticksCache[token];
    if (!tick || !tick.depth || !tick.depth.buy || tick.depth.buy.length < 3) {
        return tick?.last_price || 0;
    }
    return tick.depth.buy[2].price; // 3rd bid price (index 2)
}

// Helper function to get mid price (for future calculation)
function getMidPrice(token) {
    let tick = ticksCache[token];
    if (!tick || !tick.depth || !tick.depth.buy || !tick.depth.sell || 
        tick.depth.buy.length === 0 || tick.depth.sell.length === 0) {
        return tick?.last_price || 0;
    }
    let bestBid = tick.depth.buy[0].price;
    let bestAsk = tick.depth.sell[0].price;
    return (bestBid + bestAsk) / 2;
}

async function startInitialTrades() {
    try {
        let bn_quote = ticksCache[futureToken];
        if (!bn_quote) {
            console.log('Future quote not available yet');
            setTimeout(() => startInitialTrades(), 1000);
            return;
        }

        // Calculate synthetic future price using put-call parity with mid price
        let syntheticATM = await calculateSyntheticATM();
        
        console.log(`Starting HFT Averaging Strategy:`);
        console.log(`  Future Mid Price: ${getMidPrice(futureToken)}`);
        console.log(`  Synthetic ATM: ${syntheticATM}`);

        // Take initial positions for all strikes
        for (let strike of STRIKES) {
            await takeInitialPosition(syntheticATM, strike);
        }
    } catch (err) {
        console.log('Error in startInitialTrades:', err);
    }
}

// Calculate synthetic future price using put-call parity: F = S + C - P
// Where F = Future price, S = Strike, C = Call price, P = Put price
// Using mid prices for calculation
async function calculateSyntheticATM() {
    try {
        // Use the current future mid price to determine base strike
        let futureMidPrice = getMidPrice(futureToken);
        let baseStrike = Math.round(futureMidPrice / 100) * 100;
        
        // Get ATM call and put options
        let atmCall = currentExpiryOptions[baseStrike + 'CE'];
        let atmPut = currentExpiryOptions[baseStrike + 'PE'];
        
        if (!atmCall || !atmPut) {
            console.log('ATM options not found, using future mid price');
            return baseStrike;
        }
        
        let callMidPrice = getMidPrice(atmCall.instrument_token);
        let putMidPrice = getMidPrice(atmPut.instrument_token);
        
        if (!callMidPrice || !putMidPrice) {
            console.log('Option prices not available, using future mid price');
            return baseStrike;
        }
        
        // Calculate synthetic future price: Strike + Call - Put
        let syntheticFuture = baseStrike + callMidPrice - putMidPrice;
        
        // Round to nearest 100 for ATM calculation
        let syntheticATM = Math.round(syntheticFuture / 100) * 100;
        
        console.log(`Synthetic Future Calculation (using mid prices):`);
        console.log(`  Base Strike: ${baseStrike}`);
        console.log(`  ATM Call (${atmCall.tradingsymbol}) Mid: ₹${callMidPrice.toFixed(2)}`);
        console.log(`  ATM Put (${atmPut.tradingsymbol}) Mid: ₹${putMidPrice.toFixed(2)}`);
        console.log(`  Synthetic Future: ${baseStrike} + ${callMidPrice.toFixed(2)} - ${putMidPrice.toFixed(2)} = ${syntheticFuture.toFixed(2)}`);
        console.log(`  Synthetic ATM: ${syntheticATM}`);
        
        return syntheticATM;
    } catch (err) {
        console.log('Error calculating synthetic ATM:', err);
        let futureMidPrice = getMidPrice(futureToken);
        return Math.round(futureMidPrice / 100) * 100;
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

        let ce_ltp = getMidPrice(ce_option.instrument_token); // Use mid price for entry
        let pe_ltp = getMidPrice(pe_option.instrument_token); // Use mid price for entry

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

        // Add new entry - will be updated with actual fill prices
        let newEntry = {
            cePrice: cePrice, // Estimated price, will be updated with fill price
            pePrice: pePrice, // Estimated price, will be updated with fill price
            pairPrice: pairPrice, // Estimated price, will be updated with fill price
            estimatedCEPrice: cePrice, // Store original estimate for difference calculation
            estimatedPEPrice: pePrice, // Store original estimate for difference calculation
            qty: qty,
            timestamp: new Date(),
            ceFilled: false,
            peFilled: false,
            fillPriceUpdated: false
        };
        
        position.entries.push(newEntry);

        // Temporarily update totals (will be recalculated when fills come in)
        position.totalQty += qty;
        position.totalCost += pairPrice * qty;
        position.avgPrice = position.totalCost / position.totalQty;
        position.isActive = true;

        // Reduce target by reduction percentage for non-initial entries
        if (!isInitial && position.entries.length > 1) {
            position.currentTarget = position.currentTarget * (1 - TARGET_REDUCTION_PERCENT / 100);
            console.log(`📉 Target reduced to: ${position.currentTarget.toFixed(2)} (${TARGET_REDUCTION_PERCENT}% reduction)`);
        }

        // Place buy orders for both CE and PE with event tracking
        await sendOrderWithTracking(position.ce.option, 'BUY', qty, strikeKey, 'CE', isInitial ? 'buy_entry' : 'buy_averaging', isInitial);
        await sendOrderWithTracking(position.pe.option, 'BUY', qty, strikeKey, 'PE', isInitial ? 'buy_entry' : 'buy_averaging', isInitial);

        console.log(`${strikeKey} PAIR - Entry placed: Qty=${qty}, CE≈${cePrice}, PE≈${pePrice}, EstPairPrice=${pairPrice}, EstAvgPrice=${position.avgPrice.toFixed(2)}, TotalQty=${position.totalQty}, Target=${position.currentTarget.toFixed(2)}`);
        console.log(`   ⏳ Waiting for fill prices to update actual averages...`);
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
        let ce_mid = getMidPrice(position.ce.option.instrument_token); // Use mid price for tracking
        let pe_mid = getMidPrice(position.pe.option.instrument_token); // Use mid price for tracking

        if (!ce_mid || !pe_mid) return;

        // Skip if exit is already in progress
        if (position.exitInProgress) {
            return;
        }

        // Update last prices (using mid for tracking)
        position.ce.lastPrice = ce_mid;
        position.pe.lastPrice = pe_mid;
        let currentPairPrice = ce_mid + pe_mid; // Use mid prices for tracking

        // Only check targets if we have actual filled entries
        let filledEntries = position.entries.filter(entry => entry.fillPriceUpdated);
        if (filledEntries.length === 0) {
            console.log(`⏳ ${strikeKey}: Waiting for order fills to calculate accurate averages...`);
            return;
        }

        // Check for target hit using mid prices
        let targetPrice = position.avgPrice + position.currentTarget;
        if (currentPairPrice >= targetPrice) {
            console.log(`🎯 PAIR TARGET HIT for ${strikeKey}! Current Pair Price (mid): ${currentPairPrice.toFixed(2)}, Target: ${targetPrice.toFixed(2)}`);
            await squareOffPair(strikeKey);
            return;
        }

        // Check for averaging opportunity using mid prices
        let avgTriggerPrice = position.avgPrice - AVERAGING_TRIGGER;
        if (currentPairPrice <= avgTriggerPrice) {
            // Calculate next quantity (increase by 1 for each averaging)
            let nextQty = position.entries.length + 1;

            // Check max averaging steps limit (total entries including initial)
            if (position.entries.length >= MAX_AVERAGING_STEPS) {
                console.log(`⚠️ MAX AVERAGING STEPS REACHED for ${strikeKey}! Current steps: ${position.entries.length}, Max: ${MAX_AVERAGING_STEPS}`);
                console.log(`   No more averaging allowed, waiting for target or manual intervention...`);
                return;
            }

            console.log(`📉 PAIR Averaging trigger for ${strikeKey}! Current: ${currentPairPrice.toFixed(2)}, Trigger: ${avgTriggerPrice.toFixed(2)}, Next Qty: ${nextQty}, Step: ${position.entries.length + 1}/${MAX_AVERAGING_STEPS}`);
            await addPairEntry(strikeKey, ce_mid, pe_mid, nextQty, false);
        }
    } catch (err) {
        console.log(`Error checking pair position for ${strikeKey}:`, err);
    }
}

async function squareOffPair(strikeKey) {
    try {
        let position = positions[strikeKey];

        // Check if exit is already in progress to prevent duplicate orders
        if (position.exitInProgress) {
            console.log(`⚠️ Exit already in progress for ${strikeKey}, skipping duplicate order`);
            return;
        }

        // Set exit in progress flag immediately to prevent duplicate calls
        position.exitInProgress = true;
        position.ceExitFilled = false;
        position.peExitFilled = false;

        console.log(`🔄 PAIR Position square-off orders being placed for ${strikeKey}`);
        console.log(`   Total Qty: ${position.totalQty}, Avg Pair Price: ${position.avgPrice.toFixed(2)}`);

        // Place sell orders for both CE and PE to square off with tracking
        await sendOrderWithTracking(position.ce.option, 'SELL', position.totalQty, strikeKey, 'CE', 'sell_exit', false);
        await sendOrderWithTracking(position.pe.option, 'SELL', position.totalQty, strikeKey, 'PE', 'sell_exit', false);

        console.log(`✅ PAIR Position square-off orders placed for ${strikeKey}`);
        console.log(`   ⏳ Waiting for exit fill prices for accurate P&L calculation...`);
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
                
                // Set exit in progress
                position.exitInProgress = true;
                position.ceExitFilled = false;
                position.peExitFilled = false;
                
                // Square off both CE and PE positions with tracking
                await sendOrderWithTracking(position.ce.option, 'SELL', position.totalQty, strikeKey, 'CE', 'sell_exit', false);
                await sendOrderWithTracking(position.pe.option, 'SELL', position.totalQty, strikeKey, 'PE', 'sell_exit', false);
            }
        }
        
        console.log('✅ All exit orders placed. Strategy stopped permanently.');
        console.log('⏳ Waiting for all fills to complete for final P&L calculation...');
        
    } catch (err) {
        console.log('Error exiting all positions:', err);
    }
}

async function sendOrderWithTracking(option, transType, qty = 1, strikeKey = '', optionType = '', action = '', isInitial = false) {
    try {
        // Use mid price for all orders
        let price = getMidPrice(option.instrument_token);
        
        if (!price) {
            price = ticksCache[option.instrument_token]?.last_price || 0;
        }
        
        // Create event ID for tracking
        let eventTrigger_id = eventId();
        eventTrigger[eventTrigger_id] = {
            strikeKey: strikeKey,
            optionType: optionType,
            action: action,
            instrument: option,
            transType: transType,
            qty: qty,
            isInitial: isInitial,
            estimatedPrice: price
        };
        
        // Track order in stoploss tracker for P&L calculation (using estimated price initially)
        stoplossTracker.addOrder(option, price, transType, qty);
        
        // Paper trade tracking with event ID for fill tracking
        PaperTrade.trackOrder_v2(option, transType, strategyTag, qty, [eventTrigger_id]);
        console.log(`📋 ${transType} order placed for ${option.tradingsymbol} (Qty: ${qty}) @ ~₹${price} (Event ID: ${eventTrigger_id})`);
    } catch (err) {
        console.log('Error placing order with tracking:', err);
    }
}

var checkPositionsQ = async.queue(function (task, callback) {
    checkPositions().then(function (res) {
        callback();
    });
}, 1);

// Legacy sendOrder function for compatibility (now uses sendOrderWithTracking internally)
async function sendOrder(option, transType, qty = 1) {
    try {
        await sendOrderWithTracking(option, transType, qty, '', '', 'legacy', false);
    } catch (err) {
        console.log('Error in legacy sendOrder:', err);
    }
}

// Status reporting function
function getStrategyStatus() {
    console.log('\n📊 HFT Pair Averaging Strategy Status (Synthetic ATM):');
    console.log('=====================================');
    
    // Show overall P&L and strategy status
    let overallPNL = 0;
    try {
        overallPNL = stoplossTracker.getPNL(ticksCache);
    } catch (err) {
        console.log('Error calculating overall P&L:', err);
    }
    
    // Show synthetic vs actual comparison
    let futureMidPrice = getMidPrice(futureToken) || 0;
    console.log(`💰 Overall P&L: ₹${overallPNL.toFixed(2)} | Target: ₹${PROFIT_TARGET} | Status: ${STRATEGY_STOPPED ? '🛑 STOPPED' : '✅ ACTIVE'}`);
    console.log(`📈 Future Mid Price: ${futureMidPrice.toFixed(2)} | Using Synthetic ATM for positioning`);

    for (let strikeKey in positions) {
        console.log(`\n${strikeKey}:`);

        let pos = positions[strikeKey];
        if (pos.isActive) {
            let currentMidPairPrice = pos.ce.lastPrice + pos.pe.lastPrice; // Mid prices
            let targetPrice = pos.avgPrice + pos.currentTarget;
            let triggerPrice = pos.avgPrice - AVERAGING_TRIGGER;
            let maxStepsReached = pos.entries.length >= MAX_AVERAGING_STEPS;
            let filledEntries = pos.entries.filter(entry => entry.fillPriceUpdated).length;
            let pendingFills = pos.entries.length - filledEntries;
            let totalSlippage = 0;
            
            // Calculate total slippage for filled entries
            pos.entries.forEach(entry => {
                if (entry.fillPriceUpdated) {
                    let estimatedPair = entry.estimatedCEPrice + entry.estimatedPEPrice;
                    totalSlippage += (entry.pairPrice - estimatedPair) * entry.qty;
                }
            });

            console.log(`  PAIR: Active | Qty: ${pos.totalQty} | Avg: ₹${pos.avgPrice.toFixed(2)} | Current (mid): ₹${currentMidPairPrice.toFixed(2)} | Steps: ${pos.entries.length}/${MAX_AVERAGING_STEPS}`);
            console.log(`        Target: ₹${targetPrice.toFixed(2)} (${pos.currentTarget.toFixed(2)} pts) | Trigger: ₹${triggerPrice.toFixed(2)}${maxStepsReached ? ' | MAX STEPS REACHED!' : ''}`);
            console.log(`        CE Mid: ₹${pos.ce.lastPrice} | PE Mid: ₹${pos.pe.lastPrice} | Filled/Total Entries: ${filledEntries}/${pos.entries.length}${pendingFills > 0 ? ` | ⏳ ${pendingFills} pending fills` : ''}`);
            
            if (totalSlippage !== 0 && filledEntries > 0) {
                console.log(`        💸 Total Slippage: ${totalSlippage >= 0 ? '+' : ''}₹${totalSlippage.toFixed(2)} | Avg per Entry: ₹${(totalSlippage / filledEntries).toFixed(2)}`);
            }
            if (pos.exitInProgress) {
                console.log(`        🔄 EXIT IN PROGRESS: CE Fill: ${pos.ceExitFilled ? '✅' : '⏳'} | PE Fill: ${pos.peExitFilled ? '✅' : '⏳'}`);
            }
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

// Get detailed slippage analysis
function getSlippageAnalysis() {
    console.log('\n📈 Slippage Analysis:');
    console.log('=====================');
    
    for (let strikeKey in positions) {
        let pos = positions[strikeKey];
        if (pos.entries.length > 0) {
            console.log(`\n${strikeKey}:`);
            
            let totalSlippage = 0;
            let entryCount = 0;
            
            pos.entries.forEach((entry, index) => {
                if (entry.fillPriceUpdated) {
                    let estimatedPair = entry.estimatedCEPrice + entry.estimatedPEPrice;
                    let actualPair = entry.pairPrice;
                    let slippage = (actualPair - estimatedPair) * entry.qty;
                    totalSlippage += slippage;
                    entryCount++;
                    
                    console.log(`  Entry ${index + 1}: Est ₹${estimatedPair.toFixed(2)} → Fill ₹${actualPair.toFixed(2)} | Qty: ${entry.qty} | Slippage: ${slippage >= 0 ? '+' : ''}₹${slippage.toFixed(2)}`);
                } else if (entry.ceFilled || entry.peFilled) {
                    console.log(`  Entry ${index + 1}: ⏳ Partial fill (CE: ${entry.ceFilled ? '✅' : '⏳'}, PE: ${entry.peFilled ? '✅' : '⏳'})`);
                } else {
                    console.log(`  Entry ${index + 1}: ⏳ Pending fills`);
                }
            });
            
            if (entryCount > 0) {
                console.log(`  Total Slippage: ${totalSlippage >= 0 ? '+' : ''}₹${totalSlippage.toFixed(2)} | Avg per Entry: ₹${(totalSlippage / entryCount).toFixed(2)}`);
            }
        }
    }
    console.log('=====================\n');
}

// Export functions
module.exports = {
    setTargetPoints,
    setAveragingTrigger,
    setTargetReduction,
    setMaxAveragingSteps,
    getStrategyStatus,
    cancelPendingOrders,
    getSlippageAnalysis
};

// Start strategy
runStrategy();

// Status reporting every 30 seconds
setInterval(getStrategyStatus, 300000);

// Schedule strategy to run during market hours
// new CronJob('45 16 9 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');

// Exit at market close
// new CronJob('0 21 15 * * 1-5', function () {
//   console.log('Market closed, exiting strategy...');
//   STRATEGY_STOPPED = true;
//   // Square off all active positions
//   for (let strikeKey in positions) {
//     if (positions[strikeKey].isActive) {
//       sendOrder(positions[strikeKey].ce.option, 'SELL', positions[strikeKey].totalQty);
//       sendOrder(positions[strikeKey].pe.option, 'SELL', positions[strikeKey].totalQty);
//     }
//   }
//   setTimeout(function () {
//     process.exit();
//   }, 5000);
// }, null, true, 'Asia/Kolkata');
