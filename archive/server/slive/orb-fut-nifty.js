require('./orb-fut-core.js')({
  strategyTag: 'ORB_FUT_NIFTY',
  underlying: 'NIFTY',
  rangeFilterPts: 0,   // no filter
  lots: 1,
  bufferPct: 0.001,
});
