function ndist(z) {
  return (1.0 / (Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * z);
}

function N(z) {
  b1 = 0.31938153;
  b2 = -0.356563782;
  b3 = 1.781477937;
  b4 = -1.821255978;
  b5 = 1.330274429;
  p = 0.2316419;
  c2 = 0.3989423;
  a = Math.abs(z);
  if (a > 6.0) {
    return 1.0;
  }
  t = 1.0 / (1.0 + a * p);
  b = c2 * Math.exp((-z) * (z / 2.0));
  n = ((((b5 * t + b4) * t + b3) * t + b2) * t + b1) * t;
  n = 1.0 - b * n;
  if (z < 0.0) {
    n = 1.0 - n;
  }
  return n;
}

function black_scholes(call, S, X, r, v, t) {
  // call = Boolean (to calc call, call=True, put: call=false)
  // S = stock prics, X = strike price, r = no-risk interest rate
  // v = volitility (1 std dev of S for (1 yr? 1 month?, you pick)
  // t = time to maturity

  // define some temp vars, to minimize function calls
  var sqt = Math.sqrt(t);
  var Nd2; //N(d2), used often
  var nd1; //n(d1), also used often
  var ert; //e(-rt), ditto
  var delta; //The delta of the option

  d1 = (Math.log(S / X) + r * t) / (v * sqt) + 0.5 * (v * sqt);
  d2 = d1 - (v * sqt);

  if (call) {
    delta = N(d1);
    Nd2 = N(d2);
  } else { //put
    delta = -N(-d1);
    Nd2 = -N(-d2);
  }

  ert = Math.exp(-r * t);
  nd1 = ndist(d1);

  gamma = nd1 / (S * v * sqt);
  vega = S * sqt * nd1;
  theta = -(S * v * nd1) / (2 * sqt) - r * X * ert * Nd2;
  rho = X * t * ert * Nd2;

  // return (S * delta - X * ert * Nd2);
  return delta;
}

function option_implied_volatility(call, S, X, r, t, o) {
  // call = Boolean (to calc call, call=True, put: call=false)
  // S = stock prics, X = strike price, r = no-risk interest rate
  // t = time to maturity
  // o = option price

  // define some temp vars, to minimize function calls
  sqt = Math.sqrt(t);
  MAX_ITER = 100;
  ACC = 0.000001;

  sigma = (o / S) / (0.398 * sqt);
  for (i = 0; i < MAX_ITER; i++) {
    price = black_scholes(call, S, X, r, sigma, t);
    diff = o - price;
    if (Math.abs(diff) < ACC) return sigma;
    d1 = (Math.log(S / X) + r * t) / (sigma * sqt) + 0.5 * sigma * sqt;
    vega = S * sqt * ndist(d1);
    sigma = sigma + diff / vega;
  }
  return "Error, failed to converge";

}

module.exports = black_scholes;
