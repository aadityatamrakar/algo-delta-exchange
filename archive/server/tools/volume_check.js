const CronJob = require("cron").CronJob;
const app = require('../server.js');
const zerodha = require('../lib/zerodha.js');
const Account = app.models.account;
const notify = require("../lib/notify.js");
const stocks = require('./../../instruments-sme-tokens.json');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const fs = require('fs');

let strategyTag = 'AlgoEQ';
let channelId = 0;

let zapi, public_token;
async function zerodha_init(account) {
    let zapi_n = new zerodha();
    zapi_n.loadConfig(account);
    let login_resp = await zapi_n.login();
    account.lastLogin = (new Date()).toISOString().substr(0, 10);
    account.config = await zapi_n.getConfig();
    public_token = zapi_n.getAuthorization();
    await account.save();
    if (login_resp === false) return false;
    else return zapi_n;
}

async function runStrategy() {
    try {
        let masterId = app.get('masterId');
        let base_acc = await Account.findById(masterId);
        zapi = await zerodha_init(base_acc);

        fromDate = new Date();
        fromDate.setDate(fromDate.getDate() - 30);
        toDate = new Date();

        let result = "";
        for (let i = 0; i < stocks.length; i++) {
            let candleData = await zapi.historyData(stocks[i].instrument_token, 'day', fromDate.toISOString().substr(0, 10), toDate.toISOString().substr(0, 10));
            if (checkVolume(candleData)) {
                result += `${stocks[i].tradingsymbol}\n`;
            }
            console.log(`Volume Alert: ${stocks[i].tradingsymbol} - ${stocks[i].name} - No Volume`);
            await sleep(5000);
        }
        console.log(result);
        fs.writeFileSync('volume_alert.txt', result);
        notify(`Volume Alert: \n${result}`, channelId);
        setTimeout(() => {
            process.exit(0);
        }, 5000);
    } catch (err) {
        console.log(err);
    }
}

function checkVolume(data) {
    let avgVolume = 0;
    if (!data) return false;
    else if (data.length < 2) return false;
    else {
        try {
            let todayVolume = data[data.length - 1].vol;
            for (let i = 0; i < data.length - 1; i++) {
                avgVolume += data[i].vol;
            }
            avgVolume /= (data.length - 1);
            console.log(`Today Volume: ${todayVolume}, Avg Volume: ${avgVolume}`);
            if (todayVolume > 5 * avgVolume) return true;
        } catch (err) {
            console.log(err);
        }
    }
    return false;
}

// runStrategy();
new CronJob('0 0 21 * * 1-5', runStrategy, null, true, 'Asia/Kolkata');
