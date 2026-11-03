function mean(values) {
  if (values.length == 0)
    return NaN;

  return values.reduce((sum, e) => sum + e, 0) / values.length;
}

function median(values) {
  if (values.length == 0)
    return NaN;

  let arr = values.slice(0).sort((a, b) => a - b);
  let half = ~~(arr.length / 2);

  return (arr.length % 2) ? arr[half] : (arr[half - 1] + arr[half]) / 2.0;
}

// Variance = average squared deviation from mean
function variance(values) {
  let avg = mean(values);
  return mean(values.map((e) => Math.pow(e - avg, 2)));
}

// Standard Deviation = sqrt of variance
function stdev(values) {
  return Math.sqrt(variance(values));
}

const stat = {
  mean,
  median,
  variance,
  stdev
}

function outlier(array, opts, callback) {
  let threshold = opts && opts.threshold || 3;

  let arr = array.map((e, i) => Math.round(Math.abs(e - (array[i > 0 && (i - 1) || 0]))) + 1);
  let median = stat.median(arr);

  let check = (e) => e / median > threshold;

  let res = (opts && !!opts.indexes) ?
    arr.map((e, i) => check(e) && i).filter((e) => e !== false) :
    array.filter((e, i) => check(arr[i]));

  return (callback) ? callback(null, res) : res;
}


function __triggerKeyboardEvent(el, keyCode) {
  var eventObj = document.createEventObject ?
    document.createEventObject() : document.createEvent("Events");
  if (eventObj.initEvent) {
    eventObj.initEvent("keydown", true, true);
  }
  eventObj.keyCode = keyCode;
  eventObj.which = keyCode;
  el.dispatchEvent ? el.dispatchEvent(eventObj) : el.fireEvent("onkeydown", eventObj);
}

function triggerKeyboardEvent(el, keyCode) {
  var keyboardEvent = document.createEvent("KeyboardEvent");

  var initMethod = typeof keyboardEvent.initKeyboardEvent !== 'undefined' ? "initKeyboardEvent" : "initKeyEvent";


  keyboardEvent[initMethod](
    "keydown",
    true, // bubbles oOooOOo0
    true, // cancelable   
    window, // view
    false, // ctrlKeyArg
    false, // altKeyArg
    false, // shiftKeyArg
    false, // metaKeyArg
    keyCode,
    0 // charCode   
  );

  el.dispatchEvent(keyboardEvent);
}
