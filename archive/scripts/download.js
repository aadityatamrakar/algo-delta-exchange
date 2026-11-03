let zerodha = require('./server/lib/zerodha');
let zapi = new zerodha();
let config = require('./zerodha_config.json');
let fs = require('fs');

let instrument = '779521';
let period = 'minute';
let filename = 'SBIN_1min.csv';

// 341249   - HDFCBANK
// 1270529  - ICICIBANK
// 1510401  - AXISBANK
// 492033   - KOTAKBANK
// 779521   - SBIN
// 579329   - BANDHANBNK
// 1346049  - INDUSINDBK
// 264969   - VIX

async function downloadYearData(instrument, period, year) {
    let tmp, resp = [];

    tmp = await zapi.historyData(instrument, period, year + '-01-01', year + '-01-31');
    resp.push(tmp);
    tmp = await zapi.historyData(instrument, period, year + '-02-01', year + '-02-28');
    resp.push(tmp);
    tmp = await zapi.historyData(instrument, period, year + '-03-01', year + '-03-31');
    resp.push(tmp);
    tmp = await zapi.historyData(instrument, period, year + '-04-01', year + '-04-30');
    resp.push(tmp);
    tmp = await zapi.historyData(instrument, period, year + '-05-01', year + '-05-31');
    resp.push(tmp);
    tmp = await zapi.historyData(instrument, period, year + '-06-01', year + '-06-30');
    resp.push(tmp);
    tmp = await zapi.historyData(instrument, period, year + '-07-01', year + '-07-31');
    resp.push(tmp);
    tmp = await zapi.historyData(instrument, period, year + '-08-01', year + '-08-31');
    resp.push(tmp);
    tmp = await zapi.historyData(instrument, period, year + '-09-01', year + '-09-30');
    resp.push(tmp);
    tmp = await zapi.historyData(instrument, period, year + '-10-01', year + '-10-31');
    resp.push(tmp);
    tmp = await zapi.historyData(instrument, period, year + '-11-01', year + '-11-30');
    resp.push(tmp);
    tmp = await zapi.historyData(instrument, period, year + '-12-01', year + '-12-31');
    resp.push(tmp);
    console.log('downloaded ' + year + '...')
    resp = [].concat.apply([], resp);

    return resp;
}

(async () => {
    zapi.loadConfig(config);
    let login = await zapi.login();
    console.log("login: " + login);

    let resp = [];
    let tmp = await downloadYearData(instrument, period, '2018');
    resp.push(tmp);
    tmp = await downloadYearData(instrument, period, '2019');
    resp.push(tmp);
    tmp = await downloadYearData(instrument, period, '2020');
    resp.push(tmp);
    tmp = await downloadYearData(instrument, period, '2021');
    resp.push(tmp);
    tmp = await downloadYearData(instrument, period, '2022');
    resp.push(tmp);

    resp = [].concat.apply([], resp)
    fs.writeFileSync('banknifty.json', JSON.stringify(resp));

    let csv = 'date,open,high,low,close,volume\n';
    resp.forEach((item) => {
        csv += item.ts + ',' + item.open + ',' + item.high + ',' + item.low + ',' + item.close + ',' + item.vol + '\n';
    });
    fs.writeFileSync('./data/' + filename, csv);
})();
