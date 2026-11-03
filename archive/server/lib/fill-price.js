'use strict';

// Resolves the paper-fill price for an inserted order from the live tick cache.
// Orders mirrored from optionbhai carry no Kite instrument_token (its API sends
// Dhan instrument_key/security_id since Jun 2026), so when the order's token has
// no tick we fall back to the tradingsymbol -> Kite token map built from
// optionConfig. Returns { price, token } — token is the resolved Kite token so
// the caller can backfill it onto the order document.
function resolveFill(order, ticksCache, symbolTokenMap, bidAsk = 0, slippage = 0) {
  let token = order.instrument_token;
  if (!ticksCache[token] && symbolTokenMap[order.tradingsymbol]) {
    token = symbolTokenMap[order.tradingsymbol];
  }

  let price = 0.05;
  const quote = ticksCache[token];
  if (quote && typeof quote === 'object' && typeof quote.last_price === 'number') {
    price = quote.last_price;
    const depth = quote.depth;
    if (depth) {
      try {
        if (order.transaction_type === 'BUY') {
          const sellPrice = depth.sell[bidAsk]?.price;
          if (sellPrice > 50) price = slippage + sellPrice;
        } else if (order.transaction_type === 'SELL') {
          const buyPrice = depth.buy[bidAsk]?.price;
          if (buyPrice > 50) price = buyPrice - slippage;
        }
      } catch (err) { }
    }
  }
  return { price, token };
}

module.exports = { resolveFill };
