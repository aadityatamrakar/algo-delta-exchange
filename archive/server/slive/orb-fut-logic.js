// ORB v6 — pure decision logic (no I/O). Unit-tested via server/test/orb-fut-logic.test.js.

// Aggregate the first `count` 5-min candles (09:15-09:45 -> count 6) into a range.
function computeRange(candles, count = 6) {
  if (!candles || candles.length < count) return null;
  const window = candles.slice(0, count);
  const rangeHigh = Math.max(...window.map(c => c.high));
  const rangeLow = Math.min(...window.map(c => c.low));
  return { rangeHigh, rangeLow, range: rangeHigh - rangeLow };
}

// BANKNIFTY needs range >= filterPts; a falsy filter is disabled (always passes).
function passesFilter(range, filterPts) {
  if (!filterPts) return true;
  return range >= filterPts;
}

// Direction of a buffered breakout for a candle close. 'BUY' up, 'SELL' down, else null.
function breakoutSide(close, rangeHigh, rangeLow, bufferPct) {
  if (close > rangeHigh * (1 + bufferPct)) return 'BUY';
  if (close < rangeLow * (1 - bufferPct)) return 'SELL';
  return null;
}

// SL = opposite ORB end; single target measured from the fill price (1x range).
function computeLevels(side, entry, range, rangeHigh, rangeLow) {
  if (side === 'BUY') {
    return { sl: rangeLow, t1: entry + range };
  }
  return { sl: rangeHigh, t1: entry - range };
}

function openPosition(side, instrument, entry, range, rangeHigh, rangeLow, lots) {
  const { sl, t1 } = computeLevels(side, entry, range, rangeHigh, rangeLow);
  return { side, instrument, entry, sl, t1, lots, status: 'ACTIVE' };
}

// Pure exit reducer. Single lot, single target: the whole position closes on the
// first trigger. Precedence per call: forceExit -> SL -> T1, all against the same
// price. Returns the orders to place and the next position state.
function evaluateExit(position, price, opts = {}) {
  const actions = [];
  if (!position || position.status !== 'ACTIVE') {
    return { actions, position };
  }
  const p = Object.assign({}, position);
  const opp = p.side === 'BUY' ? 'SELL' : 'BUY';
  const long = p.side === 'BUY';

  if (opts.forceExit) {
    actions.push({ side: opp, lots: p.lots, reason: 'EOD' });
    p.status = 'CLOSED';
    return { actions, position: p };
  }

  const slHit = long ? price <= p.sl : price >= p.sl;
  if (slHit) {
    actions.push({ side: opp, lots: p.lots, reason: 'SL' });
    p.status = 'CLOSED';
    return { actions, position: p };
  }

  const t1Hit = long ? price >= p.t1 : price <= p.t1;
  if (t1Hit) {
    actions.push({ side: opp, lots: p.lots, reason: 'T1' });
    p.status = 'CLOSED';
    return { actions, position: p };
  }

  return { actions, position: p };
}

module.exports = { computeRange, passesFilter, breakoutSide, computeLevels, openPosition, evaluateExit };
