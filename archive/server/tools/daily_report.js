const CronJob = require("cron").CronJob;
var async = require('async');
var notify = require('../lib/notify');
var fs = require('fs');
let app, Report, Account, XtsAccount, Zerodha = require('../lib/zerodha.js');

const sgMail = require('@sendgrid/mail')
sgMail.setApiKey('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')

function roundOff(amount) {
  return String(parseInt(amount)).replace(/(\d)(?=(\d\d)+\d$)/g, "$1,")
}
async function init() {
  app = require('../server.js');
  Account = app.models.account;
  Report = app.models.report;
  XtsAccount = app.models.xtsAccount;

  let accounts = await Account.find();
  let xtsAccounts = await XtsAccount.find();

  async.mapLimit(xtsAccounts, 3, function (xtsAccount, cb3) {
    (async () => {
      try {
        let client = await XtsAccount.loginClient(xtsAccount);
        let positions = await client.getPositions({
          dayOrNet: "DayWise"
        });
        let totalAccountPnl = positions.result.positionList.reduce((s, c) => {
          s += parseFloat(c.MTM.replace(/,/g, ''))
          return s;
        }, 0);
        let resp = {
          name: xtsAccount.name,
          fullname: xtsAccount.username,
          m2m: totalAccountPnl
        };
        cb3(null, resp);
      } catch (err) {
        console.log(err);
        cb3(null, false);
      }
    })();
  }, function (err, xtsPnl) {
    async.mapLimit(accounts, 3, function (account, cb2) {
      (async () => {
        try {
          let zapi_n = new Zerodha();
          zapi_n.loadConfig(account);
          let session = await zapi_n.checkSession();
          if (!session) {
            session = await zapi_n.login();
            account.lastLogin = (new Date()).getTime();
            account.config = await zapi_n.getConfig();
            await account.save();
          }
          let orderbook = await zapi_n.orders();
          let strategies = ['Index', 'Birbal_AI', 'Birbal_LMT', 'Casino', 'Tesla', 'Pi', 'ITC', 'ITCRT', 'Chai', 'Spider', 'F2', 'ST1', 'S1', 'BTS', 'BBT', 'Urvashi', 'Strangle', 'mStrangle', 'nStrangle', 'uStrangle', 'LowRisk', 'mLowRisk', 'uLowRisk', 'Joker'];
          orderbook = orderbook.filter(order => {
            return (order.tag && strategies.indexOf(order.tag) != -1)
          });
          let symbols = Array.from(new Set(orderbook.map(c => c.tradingsymbol)));
          let positions = await zapi_n.positions();
          positions.day = positions.day.filter(c => c.product == 'MIS' && symbols.indexOf(c.tradingsymbol) != -1);
          let resp = {
            name: account.name,
            fullname: account.username || account.config.data.user_name,
            m2m: positions.day.reduce((s, a) => (s += a.m2m), 0)
          };
          cb2(null, resp);
        } catch (err) {
          console.log(err);
          cb2(null, false);
        }
      })();
    }, function (err, resp) {
      if (err) cb(err);
      else {
        resp = resp.concat(xtsPnl).filter(c => c).sort((a, b) => (Math.abs(b.m2m) - Math.abs(a.m2m)));
        let html_template = fs.readFileSync(__dirname + '/../templates/email.html', 'utf8');
        let header = `AlgoMaker Daily Report\n`;
        let mainContent, mainContentHTML;
        let footer = `*** This is an automatically generated email, please do not reply ***`;
        let totalPNL = 0;

        mainContent = resp.map(c => {
          totalPNL += c.m2m;
          return `${c.name}\t${c.fullname}\n${c.m2m}`
        }).join('\n');
        mainContentHTML = resp.map(c => {
          return `<tr>
          <td valign="top"
            style="padding:5px; font-family: Arial,sans-serif; font-size: 16px; line-height:20px;">${c.name}
          </td>
          <td valign="top"
            style="padding:5px; font-family: Arial,sans-serif; font-size: 16px; line-height:20px;">${c.fullname}
          </td>
          <td valign="top"
            style="padding:5px; text-align:right; ${c.m2m>0?'color: green;':'color: red;'} font-family: Arial,sans-serif; font-size: 16px; line-height:20px;">${roundOff(c.m2m)}
          </td>
          </tr>`;
        }).join('');
        mainContentHTML += `<tr>
        <td colspan="2" valign="top"
          style="padding:5px; font-family: Arial,sans-serif; font-size: 16px; line-height:20px;">Total PNL
        </td>
        <td valign="top"
          style="padding:5px; text-align:right; ${totalPNL>0?'color: green;':'color: red;'} font-family: Arial,sans-serif; font-size: 16px; line-height:20px;">${roundOff(totalPNL)}
        </td>
        </tr>`;

        if (totalPNL > 0) notify('Today\'s PNL: ₹' + roundOff(Math.abs(totalPNL)) + '+', 1);
        else notify('Today\'s PNL: -₹' + roundOff(Math.abs(totalPNL)), 1);
        // console.log('Today\'s PNL: ' + roundOff(totalPNL));

        let todayDate = new Date();
        todayDate.setHours(0);
        todayDate.setMilliseconds(0);
        todayDate.setMinutes(0);
        todayDate.setSeconds(0);

        Report.create({
          clientCode: 'algomaker',
          strategy: 'combine',
          pnl: totalPNL,
          ts: todayDate
        });

        const msg = {
          to: [
            "support@algomaker.in",
            "prateek.john@algomaker.in",
            "info@algomaker.in",
            "dharmik@algomaker.in",
            "neha@algomaker.in"
          ],
          from: 'AlgoSpot <jarvis@algospot.in>',
          subject: 'Daily Report',
          text: header + mainContent + footer,
          html: html_template.replace('{{::body::}}', mainContentHTML),
        }

        sgMail
          .send(msg)
          .then(() => {
            console.log('Email sent');
            process.exit(1);
          })
          .catch((error) => {
            console.error(error);
            process.exit(1);
          })
      }
    });
  })
}

// init();
new CronJob('10 30 15 * * 1-5', init, null, true, 'Asia/Kolkata');
