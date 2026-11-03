const request = require('request');
const CronJob = require("cron").CronJob;
const moment = require('moment');
const fs = require('fs');
// make get request to below url
// https://oxide.sensibull.com/v1/compute/cache/live_derivative_prices/256265

function getGreeks() {
    return new Promise((resolve, reject) => {
        request('https://oxide.sensibull.com/v1/compute/cache/live_derivative_prices/256265', function (error, response, body) {
            if (!error && response.statusCode == 200) {
                resolve(body);
            }
            else reject(error);
        });
    });
}

function saveGreeks() {
    getGreeks().then((response) => {
        let folder = 'greeks/';
        let timestamp = moment().tz('Asia/Kolkata').format('HHmmss');
        let filename = `bn_greeks_${timestamp}.json`;
        fs
            .writeFile(folder + filename, response, (err) => {
                if (err) throw err;
                console.log('The file has been saved!');
            });
    }).catch((error) => {
        console.log(error);
    });
}

new CronJob('30 14 9 * * 1-5', function () {
    new CronJob('0 * * * * *', saveGreeks, null, true, 'Asia/Kolkata');
}, null, true, 'Asia/Kolkata');
new CronJob('10 30 15 * * 1-5', function () {
    process.exit();
}, null, true, 'Asia/Kolkata');
// saveGreeks();
