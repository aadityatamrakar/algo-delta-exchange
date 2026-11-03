// Numerical approximations for the normal PDF and CDF
function normsdist(_x, _cumulative) {
  let _pdf, _cdf, _t;
  // density of the standard normal distribution
  _pdf = (1 / Math.sqrt(2 * Math.PI) * Math.exp(-Math.pow(_x, 2) / 2));
  if (!_cumulative) {
    return _pdf;
  } else {
    // Zelen & Severo (1964) approximation of the cumulative distribution function of the standard normal distribution
    _t = 1 / (1 + 0.2316419 * Math.abs(_x));
    _cdf = 1 - _pdf * (0.31938153 * _t - 0.356563782 * Math.pow(_t, 2) + 1.781477937 * Math.pow(_t, 3) - 1.821255978 * Math.pow(_t, 4) + 1.330274429 * Math.pow(_t, 5));
    if (_x > 0) {
      return _cdf;
    } else {
      return 1 - _cdf;
    }
  }
}

// Black-Scholes-Merton (BSM) - Price
function bsm_price(_type, _X, _K, _t, _r, _q, _s) {
  let _d1, _d2;
  _d1 = (Math.log(_X / _K) + (_r - _q + Math.pow(_s, 2) / 2) * _t) / (_s * Math.sqrt(_t));
  _d2 = _d1 - _s * Math.sqrt(_t);
  if (_type == "C") {
    return Math.exp(-_q * _t) * normsdist(_d1, true) * _X - Math.exp(-_r * _t) * normsdist(_d2, true) * _K;
  } else {
    return Math.exp(-_r * _t) * normsdist(-_d2, true) * _K - Math.exp(-_q * _t) * normsdist(-_d1, true) * _X;
  }
}

// Black-76 (B76) - Price
function b76_price(_type, _X, _K, _t, _r, _s) {
  let _d1, _d2;
  _d1 = (Math.log(_X / _K) + (Math.pow(_s, 2) / 2) * _t) / (_s * Math.sqrt(_t));
  _d2 = _d1 - _s * Math.sqrt(_t);
  if (_type == "C") {
    return Math.exp(-_r * _t) * (normsdist(_d1, true) * _X - normsdist(_d2, true) * _K);
  } else {
    return Math.exp(-_r * _t) * (normsdist(-_d2, true) * _K - normsdist(-_d1, true) * _X);
  }
}

// Bachelier Futures Spread (BFS) - Price
function bfs_price(_type, _X, _K, _t, _r, _s) {
  let _d;
  _d = (_X - _K) / (_s * Math.sqrt(_t));
  if (_type == "C") {
    return Math.exp(-_r * _t) * (normsdist(_d, true) * (_X - _K) + normsdist(_d, false) * (_s * Math.sqrt(_t)));
  } else {
    return Math.exp(-_r * _t) * (normsdist(-_d, true) * (_K - _X) + normsdist(_d, false) * (_s * Math.sqrt(_t)));
  }
}

// Black-Scholes-Merton (BSM) - Implied Volatility
function bsm_ivol(_type, _X, _K, _t, _r, _q, _optPrc) {
  let _functionError = 0.000001;
  let _volError = 0.0001;
  let _volLower = 0.0001;
  let _volUpper = 9.0;
  let _volMid = (_volUpper + _volLower) / 2;
  while (Math.abs(bsm_price(_type, _X, _K, _t, _r, _q, _volMid) - _optPrc) > _functionError && Math.abs(_volUpper - _volLower) > _volError) {
    if (bsm_price(_type, _X, _K, _t, _r, _q, _volMid) - _optPrc >= 0) {
      _volUpper = _volMid;
    } else {
      _volLower = _volMid;
    }
    _volMid = (_volLower + _volUpper) / 2;
  }
  return _volMid;
}

// Black-76 (B76) - Implied Volatility
function b76_ivol(_type, _X, _K, _t, _r, _optPrc) {
  let _functionError = 0.000001;
  let _volError = 0.0001;
  let _volLower = 0.0001;
  let _volUpper = 9.0;
  let _volMid = (_volUpper + _volLower) / 2;
  while (Math.abs(b76_price(_type, _X, _K, _t, _r, _volMid) - _optPrc) > _functionError && Math.abs(_volUpper - _volLower) > _volError) {
    if (b76_price(_type, _X, _K, _t, _r, _volMid) - _optPrc >= 0) {
      _volUpper = _volMid;
    } else {
      _volLower = _volMid;
    }
    _volMid = (_volLower + _volUpper) / 2;
  }
  return _volMid;
}

// Bachelier Futures Spread (BFS) - Implied Volatility
function bfs_ivol(_type, _X, _K, _t, _r, _optPrc) {
  let _functionError = 0.000001;
  let _volError = 0.01;
  let _volLower = 0.01;
  let _volUpper = 999;
  let _volMid = (_volUpper + _volLower) / 2;
  while (Math.abs(bfs_price(_type, _X, _K, _t, _r, _volMid) - _optPrc) > _functionError && Math.abs(_volUpper - _volLower) > _volError) {
    if (bfs_price(_type, _X, _K, _t, _r, _volMid) - _optPrc >= 0) {
      _volUpper = _volMid;
    } else {
      _volLower = _volMid;
    }
    _volMid = (_volLower + _volUpper) / 2;
  }
  return _volMid;
}

/*

X      = underlying price;
K      = strike price;
t      = time to expiration (% of year);
s      = volatility (% p.a. except in BFS formula);
r      = risk-free interest rate (% p.a.);
q      = dividend yield (% p.a.);
N()    = cumulative distribution function of the standard normal distribution;
n()    = probability density function of the standard normal distribution;
exp()  = exponential function;
sqrt() = square root function;
Pi     = Archimedes' constant (~3.14159);

*/

// ---------------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------------

module.exports = {
  normsdist,
  bsm_price,
  b76_price,
  bfs_price,
  bsm_ivol,
  b76_ivol,
  bfs_ivol,
}
