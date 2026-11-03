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
let strategyTag = 'SNX_HFT_SELL';
let TARGET_POINTS = 10; // Target points for profit
let STOPLOSS_POINTS = 20; // Stoploss points
let STRIKES = [0];
let PROFIT_TARGET = 3000000; // Exit all positions when profit reaches this amount
let STRATEGY_STOPPED = false; // Flag to stop strategy when profit target is reached

// Strategy state
let currentPosition = null; // 'LONG' or 'SHORT'
let positionActive = false;

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
            
            if (eventData.action === 'entry') {
                await updatePositionWithFillPrice(eventData.strikeKey, eventData.optionType, fillPrice, eventData.qty);
            } else if (eventData.action === 'exit') {
                await updateExitWithFillPrice(eventData.strikeKey, eventData.optionType, fillPrice, eventData.qty);
            }
            
            // Clean up event trigger
            eventTrigger[eventTrgIdx] = false;
        }
    } catch (err) {
        console.log('Error handling order fill:', err);
    }
}

async function updatePositionWithFillPrice(strikeKey, optionType, fillPrice, qty) {
    try {
        let position = positions[strikeKey];
        if (!position) return;
        
        // Update the entry with actual fill price
        if (optionType === 'CE') {
            let priceDifference = fillPrice - position.estimatedCEPrice;
            position.cePrice = fillPrice;
            position.ceFilled = true;
            
            console.log(`📋 CE Fill for ${strikeKey}: Est ₹${position.estimatedCEPrice} → Fill ₹${fillPrice} (Diff: ${priceDifference >= 0 ? '+' : ''}₹${priceDifference.toFixed(2)})`);
        } else if (optionType === 'PE') {
            let priceDifference = fillPrice - position.estimatedPEPrice;
            position.pePrice = fillPrice;
            position.peFilled = true;
            
            console.log(`📋 PE Fill for ${strikeKey}: Est ₹${position.estimatedPEPrice} → Fill ₹${fillPrice} (Diff: ${priceDifference >= 0 ? '+' : ''}₹${priceDifference.toFixed(2)})`);
        }
        
        // Check if both CE and PE are filled for this entry
        if (position.ceFilled && position.peFilled) {
            let pairPrice = position.cePrice + position.pePrice;
            position.entryPrice = pairPrice;
            position.fillPriceUpdated = true;
            
            // Calculate targets and stoploss based on position type
            if (position.positionType === 'LONG') {
                position.targetPrice = position.entryPrice + TARGET_POINTS;
                position.stoplossPrice = position.entryPrice - STOPLOSS_POINTS;
            } else if (position.positionType === 'SHORT') {
                position.targetPrice = position.entryPrice - TARGET_POINTS;
                position.stoplossPrice = position.entryPrice + STOPLOSS_POINTS;
            }
            
            console.log(`✅ ${position.positionType} Straddle entry completed for ${strikeKey}`);
            console.log(`   CE: ₹${position.cePrice.toFixed(2)}, PE: ₹${position.pePrice.toFixed(2)}, Pair: ₹${pairPrice.toFixed(2)}`);
            console.log(`   Entry: ₹${position.entryPrice.toFixed(2)}, Target: ₹${position.targetPrice.toFixed(2)}, SL: ₹${position.stoplossPrice.toFixed(2)}`);
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
            let pnl = 0;
            let exitReason = '';
            
            // Calculate P&L based on position type
            if (position.positionType === 'LONG') {
                pnl = (exitPairPrice - position.entryPrice) * position.totalQty;
                // Determine exit reason based on stored trigger
                if (position.exitTrigger === 'TARGET') {
                    exitReason = 'TARGET HIT';
                } else if (position.exitTrigger === 'STOPLOSS') {
                    exitReason = 'STOPLOSS HIT - REVERSING TO SHORT';
                } else {
                    exitReason = 'EXIT';
                }
            } else if (position.positionType === 'SHORT') {
                pnl = (position.entryPrice - exitPairPrice) * position.totalQty;
                // Determine exit reason based on stored trigger
                if (position.exitTrigger === 'TARGET') {
                    exitReason = 'TARGET HIT';
                } else if (position.exitTrigger === 'STOPLOSS') {
                    exitReason = 'STOPLOSS HIT - REVERSING TO LONG';
                } else {
                    exitReason = 'EXIT';
                }
            }
            
            console.log(`💰 ${position.positionType} Straddle ${exitReason} for ${strikeKey}`);
            console.log(`   Entry: ₹${position.entryPrice.toFixed(2)}, Exit: ₹${exitPairPrice.toFixed(2)}, P&L: ${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(2)}`);
            console.log(`   CE Exit: ₹${position.exitCEPrice.toFixed(2)}, PE Exit: ₹${position.exitPEPrice.toFixed(2)}`);
            
            // Determine next action based on exit reason
            let shouldReverse = exitReason.includes('REVERSING');
            let nextPositionType = null;
            
            if (shouldReverse) {
                // Reverse the position type
                nextPositionType = position.positionType === 'LONG' ? 'SHORT' : 'LONG';
                console.log(`🔄 Reversing position from ${position.positionType} to ${nextPositionType}`);
            } else {
                // Re-enter same position type
                nextPositionType = position.positionType;
                console.log(`♻️ Re-entering ${nextPositionType} position`);
            }
            
            // Reset position
            resetPosition(strikeKey);
            
            // Enter new position after 2 seconds
            setTimeout(async () => {
                if (!STRATEGY_STOPPED) {
                    let syntheticATM = await calculateSyntheticATM();
                    let strikeOffset = getStrikeOffset(strikeKey, syntheticATM);
                    console.log(`🔄 Entering new ${nextPositionType} position for ${strikeKey}...`);
                    await enterPosition(strikeKey, syntheticATM, strikeOffset, nextPositionType);
                }
            }, 2000);
        }
        
    } catch (err) {
        console.log('Error updating exit with fill price:', err);
    }
}

function resetPosition(strikeKey) {
    let position = positions[strikeKey];
    position.totalQty = 1;
    position.entryPrice = 0;
    position.isActive = false;
    position.positionType = null;
    position.exitInProgress = false;
    position.exitTrigger = null;
    position.targetPrice = 0;
    position.stoplossPrice = 0;
    position.cePrice = 0;
    position.pePrice = 0;
    position.ceFilled = false;
    position.peFilled = false;
    position.fillPriceUpdated = false;
    position.estimatedCEPrice = 0;
    position.estimatedPEPrice = 0;
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
        console.log('HFT Reversal Straddle Strategy - Live Feed Connected');
        liveFeed.subscribe(subs);
        liveFeed.setMode(liveFeed.modeFull, subs);
    });
}
let futureToken,
    currentExpiryOptions = {};

// Position tracking for each strike (simplified for reversal strategy)
let positions = {
    // Format: strikeKey: { 
    //   totalQty, entryPrice, isActive, positionType: 'LONG' or 'SHORT',
    //   ce: { option, lastPrice }, pe: { option, lastPrice },
    //   targetPrice, stoplossPrice, exitInProgress,
    //   cePrice, pePrice, ceFilled, peFilled, fillPriceUpdated,
    //   estimatedCEPrice, estimatedPEPrice,
    //   exitCEPrice, exitPEPrice, ceExitFilled, peExitFilled
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
            totalQty: 1, // Always quantity 1
            entryPrice: 0,
            isActive: false,
            positionType: null, // 'LONG' or 'SHORT'
            exitInProgress: false,
            exitTrigger: null, // 'TARGET' or 'STOPLOSS'
            targetPrice: 0,
            stoplossPrice: 0,
            cePrice: 0,
            pePrice: 0,
            ceFilled: false,
            peFilled: false,
            fillPriceUpdated: false,
            estimatedCEPrice: 0,
            estimatedPEPrice: 0,
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
        
        console.log(`Starting HFT Reversal Straddle Strategy:`);
        console.log(`  Future Mid Price: ${getMidPrice(futureToken)}`);
        console.log(`  Synthetic ATM: ${syntheticATM}`);
        console.log(`  Initial Position: LONG Straddle`);
        console.log(`  Target: ${TARGET_POINTS} points, Stoploss: ${STOPLOSS_POINTS} points`);

        // Take initial LONG positions for all strikes
        for (let strike of STRIKES) {
            let strikeKey = strike === 0 ? 'ATM' : (strike > 0 ? `P${strike}` : `M${Math.abs(strike)}`);
            await enterPosition(strikeKey, syntheticATM, strike, 'LONG');
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

async function enterPosition(strikeKey, atm, strikeOffset, positionType) {
    try {
        // Don't take new positions if strategy is stopped
        if (STRATEGY_STOPPED) {
            console.log(`❌ Strategy stopped - not taking new position for ${strikeKey}`);
            return;
        }

        let ce_strike = atm + strikeOffset;
        let pe_strike = atm + strikeOffset;

        let ce_option = currentExpiryOptions[ce_strike + 'CE'];
        let pe_option = currentExpiryOptions[pe_strike + 'PE'];

        if (!ce_option || !pe_option) {
            console.log(`Options not found for ${strikeKey} (offset ${strikeOffset})`);
            return;
        }

        let ce_ltp = getMidPrice(ce_option.instrument_token);
        let pe_ltp = getMidPrice(pe_option.instrument_token);

        if (!ce_ltp || !pe_ltp) {
            console.log(`LTP not available for ${strikeKey}`);
            return;
        }

        let position = positions[strikeKey];
        
        // Set option references
        position.ce.option = ce_option;
        position.pe.option = pe_option;
        position.ce.lastPrice = ce_ltp;
        position.pe.lastPrice = pe_ltp;
        
        // Set position type and estimated prices
        position.positionType = positionType;
        position.estimatedCEPrice = ce_ltp;
        position.estimatedPEPrice = pe_ltp;
        position.isActive = true;
        position.ceFilled = false;
        position.peFilled = false;
        position.fillPriceUpdated = false;

        // Place orders based on position type
        let transType = positionType === 'LONG' ? 'BUY' : 'SELL';
        
        await sendOrderWithTracking(ce_option, transType, position.totalQty, strikeKey, 'CE', 'entry');
        await sendOrderWithTracking(pe_option, transType, position.totalQty, strikeKey, 'PE', 'entry');

        console.log(`📍 ${positionType} Straddle entry orders placed for ${strikeKey}`);
        console.log(`   Strike: ${ce_strike}, CE≈₹${ce_ltp.toFixed(2)}, PE≈₹${pe_ltp.toFixed(2)}, Est Pair≈₹${(ce_ltp + pe_ltp).toFixed(2)}`);
        console.log(`   ⏳ Waiting for fill prices...`);
    } catch (err) {
        console.log(`Error entering position for ${strikeKey}:`, err);
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
        let ce_mid = getMidPrice(position.ce.option.instrument_token);
        let pe_mid = getMidPrice(position.pe.option.instrument_token);

        if (!ce_mid || !pe_mid) return;

        // Skip if exit is already in progress
        if (position.exitInProgress) {
            return;
        }

        // Update last prices
        position.ce.lastPrice = ce_mid;
        position.pe.lastPrice = pe_mid;
        let currentPairPrice = ce_mid + pe_mid;

        // Only check targets if we have actual filled entries
        if (!position.fillPriceUpdated) {
            return;
        }

        // Check based on position type
        if (position.positionType === 'LONG') {
            // LONG: Target hit when price goes up, stoploss when price goes down
            if (currentPairPrice >= position.targetPrice) {
                console.log(`🎯 LONG TARGET HIT for ${strikeKey}! Current: ₹${currentPairPrice.toFixed(2)}, Target: ₹${position.targetPrice.toFixed(2)}`);
                position.exitTrigger = 'TARGET';
                await exitPosition(strikeKey);
                return;
            }
            if (currentPairPrice <= position.stoplossPrice) {
                console.log(`🛑 LONG STOPLOSS HIT for ${strikeKey}! Current: ₹${currentPairPrice.toFixed(2)}, SL: ₹${position.stoplossPrice.toFixed(2)}`);
                position.exitTrigger = 'STOPLOSS';
                await exitPosition(strikeKey);
                return;
            }
        } else if (position.positionType === 'SHORT') {
            // SHORT: Target hit when price goes down, stoploss when price goes up
            if (currentPairPrice <= position.targetPrice) {
                console.log(`🎯 SHORT TARGET HIT for ${strikeKey}! Current: ₹${currentPairPrice.toFixed(2)}, Target: ₹${position.targetPrice.toFixed(2)}`);
                position.exitTrigger = 'TARGET';
                await exitPosition(strikeKey);
                return;
            }
            if (currentPairPrice >= position.stoplossPrice) {
                console.log(`🛑 SHORT STOPLOSS HIT for ${strikeKey}! Current: ₹${currentPairPrice.toFixed(2)}, SL: ₹${position.stoplossPrice.toFixed(2)}`);
                position.exitTrigger = 'STOPLOSS';
                await exitPosition(strikeKey);
                return;
            }
        }
    } catch (err) {
        console.log(`Error checking pair position for ${strikeKey}:`, err);
    }
}

async function exitPosition(strikeKey) {
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

        console.log(`🔄 ${position.positionType} Straddle exit orders being placed for ${strikeKey}`);
        console.log(`   Entry: ₹${position.entryPrice.toFixed(2)}, Target: ₹${position.targetPrice.toFixed(2)}, SL: ₹${position.stoplossPrice.toFixed(2)}`);

        // Place exit orders - opposite of entry transaction type
        let exitTransType = position.positionType === 'LONG' ? 'SELL' : 'BUY';
        
        await sendOrderWithTracking(position.ce.option, exitTransType, position.totalQty, strikeKey, 'CE', 'exit');
        await sendOrderWithTracking(position.pe.option, exitTransType, position.totalQty, strikeKey, 'PE', 'exit');

        console.log(`✅ ${position.positionType} Straddle exit orders placed for ${strikeKey}`);
        console.log(`   ⏳ Waiting for exit fill prices...`);
    } catch (err) {
        console.log(`Error exiting position for ${strikeKey}:`, err);
    }
}

// Helper function to get strike offset from strike key
function getStrikeOffset(strikeKey, currentATM) {
    if (strikeKey === 'ATM') return 0;
    if (strikeKey.startsWith('P')) return parseInt(strikeKey.substring(1));
    if (strikeKey.startsWith('M')) return -parseInt(strikeKey.substring(1));
    return 0;
}

// Function to exit all positions when profit target is reached
async function exitAllPositionsAtCost() {
    try {
        console.log('🚨 EXITING ALL POSITIONS - PROFIT TARGET REACHED!');
        
        for (let strikeKey in positions) {
            let position = positions[strikeKey];
            if (position.isActive && position.totalQty > 0) {
                console.log(`🔄 Exiting ${strikeKey} ${position.positionType} position`);
                await exitPosition(strikeKey);
            }
        }
        
        console.log('✅ All exit orders placed. Strategy stopped permanently.');
        console.log('⏳ Waiting for all fills to complete for final P&L calculation...');
        
    } catch (err) {
        console.log('Error exiting all positions:', err);
    }
}

async function sendOrderWithTracking(option, transType, qty = 1, strikeKey = '', optionType = '', action = '') {
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
            estimatedPrice: price
        };
        
        // Track order in stoploss tracker for P&L calculation
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
    console.log('\n📊 HFT Reversal Straddle Strategy Status:');
    console.log('=====================================');
    
    // Show overall P&L and strategy status
    let overallPNL = 0;
    try {
        overallPNL = stoplossTracker.getPNL(ticksCache);
    } catch (err) {
        console.log('Error calculating overall P&L:', err);
    }
    
    let futureMidPrice = getMidPrice(futureToken) || 0;
    console.log(`💰 Overall P&L: ₹${overallPNL.toFixed(2)} | Target: ₹${PROFIT_TARGET} | Status: ${STRATEGY_STOPPED ? '🛑 STOPPED' : '✅ ACTIVE'}`);
    console.log(`📈 Future Mid Price: ${futureMidPrice.toFixed(2)} | Target: ${TARGET_POINTS} pts | Stoploss: ${STOPLOSS_POINTS} pts`);

    for (let strikeKey in positions) {
        console.log(`\n${strikeKey}:`);

        let pos = positions[strikeKey];
        if (pos.isActive) {
            let currentMidPairPrice = pos.ce.lastPrice + pos.pe.lastPrice;
            let slippage = 0;
            
            if (pos.fillPriceUpdated) {
                let estimatedPair = pos.estimatedCEPrice + pos.estimatedPEPrice;
                slippage = (pos.entryPrice - estimatedPair) * pos.totalQty;
            }

            console.log(`  Position: ${pos.positionType} | Qty: ${pos.totalQty} | Entry: ₹${pos.entryPrice.toFixed(2)} | Current: ₹${currentMidPairPrice.toFixed(2)}`);
            console.log(`  Target: ₹${pos.targetPrice.toFixed(2)} | Stoploss: ₹${pos.stoplossPrice.toFixed(2)}`);
            console.log(`  CE: ₹${pos.ce.lastPrice.toFixed(2)} | PE: ₹${pos.pe.lastPrice.toFixed(2)}`);
            
            if (pos.fillPriceUpdated && slippage !== 0) {
                console.log(`  💸 Slippage: ${slippage >= 0 ? '+' : ''}₹${slippage.toFixed(2)}`);
            }
            
            if (!pos.fillPriceUpdated) {
                console.log(`  ⏳ Waiting for fills: CE ${pos.ceFilled ? '✅' : '⏳'} | PE ${pos.peFilled ? '✅' : '⏳'}`);
            }
            
            if (pos.exitInProgress) {
                console.log(`  🔄 EXIT IN PROGRESS: CE ${pos.ceExitFilled ? '✅' : '⏳'} | PE ${pos.peExitFilled ? '✅' : '⏳'}`);
            }
        } else {
            console.log(`  Position: Inactive`);
        }
    }
    console.log('=====================================\n');
}

// Configuration functions
function setTargetPoints(points) {
    TARGET_POINTS = points;
    console.log(`Target points set to: ${points}`);
}

function setStoplossPoints(points) {
    STOPLOSS_POINTS = points;
    console.log(`Stoploss points set to: ${points}`);
}

function setProfitTarget(amount) {
    PROFIT_TARGET = amount;
    console.log(`Profit target set to: ₹${amount}`);
}

// Get detailed trade analysis
function getTradeAnalysis() {
    console.log('\n📈 Trade Analysis:');
    console.log('=====================');
    
    for (let strikeKey in positions) {
        let pos = positions[strikeKey];
        if (pos.isActive || pos.fillPriceUpdated) {
            console.log(`\n${strikeKey}:`);
            
            if (pos.fillPriceUpdated) {
                let estimatedPair = pos.estimatedCEPrice + pos.estimatedPEPrice;
                let actualPair = pos.entryPrice;
                let slippage = (actualPair - estimatedPair) * pos.totalQty;
                
                console.log(`  Position: ${pos.positionType}`);
                console.log(`  Estimated Entry: ₹${estimatedPair.toFixed(2)} → Actual: ₹${actualPair.toFixed(2)}`);
                console.log(`  Slippage: ${slippage >= 0 ? '+' : ''}₹${slippage.toFixed(2)}`);
                console.log(`  Target: ₹${pos.targetPrice.toFixed(2)} | Stoploss: ₹${pos.stoplossPrice.toFixed(2)}`);
            } else {
                console.log(`  ⏳ Position entry in progress`);
            }
        }
    }
    console.log('=====================\n');
}

// Export functions
module.exports = {
    setTargetPoints,
    setStoplossPoints,
    setProfitTarget,
    getStrategyStatus,
    cancelPendingOrders,
    getTradeAnalysis
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
