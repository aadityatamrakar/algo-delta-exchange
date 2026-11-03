const CronJob = require("cron").CronJob;
const app = require('../server.js');
const Manager = app.models.manager;
const moment = require('moment');

async function startStrategies() {
    console.log(Manager.liveStrategies);
    for (let i = 0; i < Manager.liveStrategies.length; i++) {
        if (Manager.liveStrategies[i].autostart) {
            Manager.restart(Manager.liveStrategies[i].module, function (err, resp) {
                console.log('Starting...' + Manager.liveStrategies[i].name, resp);
            });
        }
    }

    new CronJob('0 * * * * 1-5', delayStartStrategies, null, true, 'Asia/Kolkata');
}
async function delayStartStrategies() {
    let currentTime = moment().add(330, 'minutes').format('HHmm');
    for (let i = 0; i < Manager.liveStrategies.length; i++) {
        if (Manager.liveStrategies[i].delay_start == currentTime) {
            Manager.restart(Manager.liveStrategies[i].module, function (err, resp) {
                console.log('Starting...' + Manager.liveStrategies[i].name, resp);
            });
        }
    }
}
async function stopStrategies() {
    console.log(Manager.liveStrategies);
    for (let i = 0; i < Manager.liveStrategies.length; i++) {
        Manager.stop(Manager.liveStrategies[i].module, function (err, resp) {
            console.log('Stopping...' + Manager.liveStrategies[i].name, resp);
        });
    }
    // placeTrade = function () {};
}

new CronJob('30 15 9 * * 1-5', startStrategies, null, true, 'Asia/Kolkata');
new CronJob('50 23 15 * * 1-5', stopStrategies, null, true, 'Asia/Kolkata');
new CronJob('0 25 15 * * 1-5', function () {
    process.exit();
}, null, true, 'Asia/Kolkata');
