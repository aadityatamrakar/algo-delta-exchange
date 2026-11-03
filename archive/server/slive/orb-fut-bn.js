require('./orb-fut-core.js')({
  strategyTag: 'ORB_FUT_BN',
  underlying: 'BANKNIFTY',
  rangeFilterPts: 250, // BANKNIFTY needs range >= 250
  lots: 1,
  bufferPct: 0.001,
});
