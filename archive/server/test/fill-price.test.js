const test = require('node:test');
const assert = require('node:assert');
const { resolveFill } = require('../lib/fill-price.js');

const TOKEN = 15842050;
const SYMBOL = 'BANKNIFTY26JUL57700CE';

function tick(last_price, depth) {
  return depth ? { last_price, depth } : { last_price };
}

// ---- direct token lookup (existing behavior) ----
test('prices from ticksCache when order token has a tick', () => {
  const ticksCache = { [TOKEN]: tick(726.25) };
  const r = resolveFill({ instrument_token: TOKEN, tradingsymbol: SYMBOL, transaction_type: 'SELL' }, ticksCache, {});
  assert.strictEqual(r.price, 726.25);
  assert.strictEqual(r.token, TOKEN);
});

test('defaults to 0.05 when token unknown and symbol unmapped', () => {
  const r = resolveFill({ tradingsymbol: 'SENSEX2671677400CE', transaction_type: 'BUY' }, {}, {});
  assert.strictEqual(r.price, 0.05);
  assert.strictEqual(r.token, undefined);
});

test('defaults to 0.05 when quote has no numeric last_price', () => {
  const ticksCache = { [TOKEN]: {} };
  const r = resolveFill({ instrument_token: TOKEN, transaction_type: 'BUY' }, ticksCache, {});
  assert.strictEqual(r.price, 0.05);
});

// ---- symbol fallback (optionbhai mirrors send no Kite instrument_token) ----
test('falls back to symbol->token map when order has no token', () => {
  const ticksCache = { [TOKEN]: tick(726.25) };
  const symbolTokenMap = { [SYMBOL]: TOKEN };
  const r = resolveFill({ tradingsymbol: SYMBOL, transaction_type: 'BUY' }, ticksCache, symbolTokenMap);
  assert.strictEqual(r.price, 726.25);
  assert.strictEqual(r.token, TOKEN); // resolved token returned so caller can backfill the doc
});

test('falls back to symbol map when order token has no tick', () => {
  const ticksCache = { [TOKEN]: tick(433.15) };
  const symbolTokenMap = { [SYMBOL]: TOKEN };
  const r = resolveFill({ instrument_token: 999, tradingsymbol: SYMBOL, transaction_type: 'BUY' }, ticksCache, symbolTokenMap);
  assert.strictEqual(r.price, 433.15);
  assert.strictEqual(r.token, TOKEN);
});

test('resolves token from symbol map even when no tick arrived yet', () => {
  const symbolTokenMap = { [SYMBOL]: TOKEN };
  const r = resolveFill({ tradingsymbol: SYMBOL, transaction_type: 'BUY' }, {}, symbolTokenMap);
  assert.strictEqual(r.price, 0.05);
  assert.strictEqual(r.token, TOKEN);
});

// ---- depth/slippage adjustment (existing behavior, premiums > 50 only) ----
test('BUY uses ask + slippage when ask > 50', () => {
  const depth = { sell: [{ price: 727.0 }], buy: [{ price: 726.0 }] };
  const ticksCache = { [TOKEN]: tick(726.25, depth) };
  const r = resolveFill({ instrument_token: TOKEN, transaction_type: 'BUY' }, ticksCache, {}, 0, 0.1);
  assert.strictEqual(r.price, 727.1);
});

test('SELL uses bid - slippage when bid > 50', () => {
  const depth = { sell: [{ price: 727.0 }], buy: [{ price: 726.0 }] };
  const ticksCache = { [TOKEN]: tick(726.25, depth) };
  const r = resolveFill({ instrument_token: TOKEN, transaction_type: 'SELL' }, ticksCache, {}, 0, 0.1);
  assert.strictEqual(r.price, 725.9);
});

test('keeps last_price when depth price is <= 50', () => {
  const depth = { sell: [{ price: 42.0 }], buy: [{ price: 41.0 }] };
  const ticksCache = { [TOKEN]: tick(41.5, depth) };
  const r = resolveFill({ instrument_token: TOKEN, transaction_type: 'BUY' }, ticksCache, {}, 0, 0.1);
  assert.strictEqual(r.price, 41.5);
});

test('uses bidAsk index into depth', () => {
  const depth = { sell: [{ price: 727.0 }, { price: 0 }, { price: 0 }, { price: 0 }, { price: 728.5 }], buy: [] };
  const ticksCache = { [TOKEN]: tick(726.25, depth) };
  const r = resolveFill({ instrument_token: TOKEN, transaction_type: 'BUY' }, ticksCache, {}, 4, 0);
  assert.strictEqual(r.price, 728.5);
});

test('survives malformed depth', () => {
  const ticksCache = { [TOKEN]: tick(726.25, { sell: null, buy: null }) };
  const r = resolveFill({ instrument_token: TOKEN, transaction_type: 'BUY' }, ticksCache, {});
  assert.strictEqual(r.price, 726.25);
});
