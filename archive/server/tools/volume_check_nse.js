const CronJob = require("cron").CronJob;
const app = require('../server.js');
const notify = require("../lib/notify.js");
const stocks = require('../../instruments-sme-tokens.json');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const fs = require('fs');
const nse = require("stock-nse-india");
const napi = new nse.NseIndia();
const async = require('async');

async function runStrategy() {
    try {
        fromDate = new Date();
        fromDate.setDate(fromDate.getDate() - 30);
        toDate = new Date();

        fromDate = String(fromDate.toISOString()).substring(0, 10)
        toDate = String(toDate.toISOString()).substring(0, 10)
        const range = {
            start: new Date(fromDate),
            end: new Date(toDate)
        };

        async.eachOfLimit(stocks, 5, async (stock, index) => {
            let symbol = stock.tradingsymbol.split('-')[0].toUpperCase();
            console.log(`Processing ${symbol}`);
            let data = await napi.getEquityHistoricalData(symbol, range);
            fs.writeFileSync('./historical/' + symbol + '.json', JSON.stringify(data, null, 2));
        }, (err) => {
            if (err) console.log(err);
        }, () => {
            console.log('All done');
        });
    } catch (err) {
        console.log(err);
    }
}

runStrategy();
// new CronJob('0 0 21 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
