let Spark = require('./../server/lib/tradelab');

async function init() {
  let client = new Spark({
    credentials: {
      user_id: "SBM95",
      password: "Abc@123456",
      twofa: "123123"
    }
  });
  await client.login();

  let profile = await client.getProfile();
  console.log(profile);
  let balance = await client.getBalance();
  console.log('Margin: ', balance);

  placeOrder(client, 47209, 25, 'BUY');
  setTimeout(_ => {
    placeOrder(client, 47209, 25, 'SELL');
  }, 3000);
}

async function placeOrder(client, instrumentId, lotSize, orderType, price) {
  let response = await client.Order({
    exchange_token: instrumentId,
    quantity: lotSize,
    order_side: orderType,
    order_tag: 'Test',
    "product": "MIS",
  });
  console.log(response);
}

init();
