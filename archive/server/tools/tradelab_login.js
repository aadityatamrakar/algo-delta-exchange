const CronJob = require("cron").CronJob;
const puppeteer = require('puppeteer');
const notify = require('./../lib/notify');

let loginAttempt = 0;
async function loginAccount() {
	const browser = await puppeteer.launch({
		// executablePath: '/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome',
		headless: true,
		args: ['--no-sandbox', '--disable-setuid-sandbox']
	});
	const page = await browser.newPage();
	await page.setUserAgent('Mozilla/5.0 (Windows NT 5.1; rv:5.0) Gecko/20100101 Firefox/5.0');
	await page.goto('https://instacorpsecurities.com/tradelab_auth');

	await page.setRequestInterception(true);
	page.on('request', request => {
		if (request.resourceType() === 'image') {
			request.abort();
		} else {
			request.continue();
		}
	});

	await page.waitForSelector('input[name="login_id"]');
	await page.type('input[name="login_id"]', 'AW0198');
	await page.waitForSelector('input[name="password"]');
	await page.type('input[name="password"]', 'Jigar@8070');
	await page.click('button[type="submit"]');
	console.log(page.url());

	await page.waitFor(1000);
	await page.waitForSelector('input[name="answers[]"]');
	await page.type('input[name="answers[]"]', '123456');
	await page.click('button[type="submit"]');
	console.log(page.url());

	await page.waitFor(1000);
	const text = await page.evaluate(() => document.body.innerText);
	console.log(page.url(), text, text == 'Success!');
	if (text == 'Success!') {
		notify('AW0198 Login Successful');
		await browser.close();
		setTimeout(() => {
			process.exit(0);
		}, 15000);
	} else if(loginAttempt < 3) {
		loginAttempt++;
		await browser.close();
		delayLogin();
	} else {
		notify('AW0198 Login Failed.');
	}
}

const randomNumberBetween10to30 = () => Math.floor(Math.random() * (30 - 10 + 1)) + 10;
const delayLogin = () => setTimeout(loginAccount, randomNumberBetween10to30());
// loginAccount();
new CronJob('0 58 8 * * 1-5', delayLogin, null, true, 'Asia/Kolkata');