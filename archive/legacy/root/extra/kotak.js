var request = require('request');

let userId = "DANGAT1";
let consumerKey = "GlKifD9FXd303V_CWi2YulP2moAa";
let appId = "webapp";
let token = "eyJ4NXQiOiJNV1E1Tm1SaE1XSTNaVFV3T1RRME1ETXdZell5WlRjek1HUmpZV1l5WVRka1lXUTNOV1ExTkE9PSIsImtpZCI6ImdhdGV3YXlfY2VydGlmaWNhdGVfYWxpYXMiLCJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJEQU5HQVQxQGNhcmJvbi5zdXBlciIsImFwcGxpY2F0aW9uIjp7Im93bmVyIjoiREFOR0FUMSIsInRpZXJRdW90YVR5cGUiOm51bGwsInRpZXIiOiJVbmxpbWl0ZWQiLCJuYW1lIjoid2ViYXBwIiwiaWQiOjM1NTAsInV1aWQiOiJiMDE2NGU1Yy1kNjgxLTQwMmMtYjJiZS1lYjdhNjA5YTNmM2UifSwiaXNzIjoiaHR0cHM6XC9cL3RyYWRlYXBpLmtvdGFrc2VjdXJpdGllcy5jb206NDQzXC9vYXV0aDJcL3Rva2VuIiwidGllckluZm8iOnsiVW5saW1pdGVkIjp7InRpZXJRdW90YVR5cGUiOiJyZXF1ZXN0Q291bnQiLCJzdG9wT25RdW90YVJlYWNoIjp0cnVlLCJzcGlrZUFycmVzdExpbWl0IjowLCJzcGlrZUFycmVzdFVuaXQiOm51bGx9fSwia2V5dHlwZSI6IlBST0RVQ1RJT04iLCJzdWJzY3JpYmVkQVBJcyI6W3sic3Vic2NyaWJlclRlbmFudERvbWFpbiI6ImNhcmJvbi5zdXBlciIsIm5hbWUiOiJQb3J0Zm9saW8tQVBJIiwiY29udGV4dCI6IlwvYXBpbVwvcG9ydGZvbGlvXC8xLjAiLCJwdWJsaXNoZXIiOiJhZG1pbiIsInZlcnNpb24iOiIxLjAiLCJzdWJzY3JpcHRpb25UaWVyIjoiVW5saW1pdGVkIn0seyJzdWJzY3JpYmVyVGVuYW50RG9tYWluIjoiY2FyYm9uLnN1cGVyIiwibmFtZSI6IlBvc2l0aW9ucy1BUEkiLCJjb250ZXh0IjoiXC9hcGltXC9wb3NpdGlvbnNcLzEuMCIsInB1Ymxpc2hlciI6ImFkbWluIiwidmVyc2lvbiI6IjEuMCIsInN1YnNjcmlwdGlvblRpZXIiOiJVbmxpbWl0ZWQifSx7InN1YnNjcmliZXJUZW5hbnREb21haW4iOiJjYXJib24uc3VwZXIiLCJuYW1lIjoiU2Vzc2lvbi1BUEkiLCJjb250ZXh0IjoiXC9hcGltXC9zZXNzaW9uXC8xLjAiLCJwdWJsaXNoZXIiOiJhZG1pbiIsInZlcnNpb24iOiIxLjAiLCJzdWJzY3JpcHRpb25UaWVyIjoiVW5saW1pdGVkIn0seyJzdWJzY3JpYmVyVGVuYW50RG9tYWluIjoiY2FyYm9uLnN1cGVyIiwibmFtZSI6Ik9yZGVycy1BUEkiLCJjb250ZXh0IjoiXC9hcGltXC9vcmRlcnNcLzEuMCIsInB1Ymxpc2hlciI6ImFkbWluIiwidmVyc2lvbiI6IjEuMCIsInN1YnNjcmlwdGlvblRpZXIiOiJVbmxpbWl0ZWQifSx7InN1YnNjcmliZXJUZW5hbnREb21haW4iOiJjYXJib24uc3VwZXIiLCJuYW1lIjoiU2NyaXBNYXN0ZXItQVBJIiwiY29udGV4dCI6IlwvYXBpbVwvc2NyaXBtYXN0ZXJcLzEuMSIsInB1Ymxpc2hlciI6ImFkbWluIiwidmVyc2lvbiI6IjEuMSIsInN1YnNjcmlwdGlvblRpZXIiOiJVbmxpbWl0ZWQifSx7InN1YnNjcmliZXJUZW5hbnREb21haW4iOiJjYXJib24uc3VwZXIiLCJuYW1lIjoiV2F0Y2hsaXN0LUFQSSIsImNvbnRleHQiOiJcL2FwaW1cL3dhdGNobGlzdFwvMi4xIiwicHVibGlzaGVyIjoiYWRtaW4iLCJ2ZXJzaW9uIjoiMi4xIiwic3Vic2NyaXB0aW9uVGllciI6IlVubGltaXRlZCJ9LHsic3Vic2NyaWJlclRlbmFudERvbWFpbiI6ImNhcmJvbi5zdXBlciIsIm5hbWUiOiJNYXJnaW5zLUFQSSIsImNvbnRleHQiOiJcL2FwaW1cL21hcmdpblwvMS4wIiwicHVibGlzaGVyIjoiYWRtaW4iLCJ2ZXJzaW9uIjoiMS4wIiwic3Vic2NyaXB0aW9uVGllciI6IlVubGltaXRlZCJ9LHsic3Vic2NyaWJlclRlbmFudERvbWFpbiI6ImNhcmJvbi5zdXBlciIsIm5hbWUiOiJSZXBvcnRzLUtTRUMiLCJjb250ZXh0IjoiXC9hcGltXC9yZXBvcnRzXC8xLjAiLCJwdWJsaXNoZXIiOiJhZG1pbiIsInZlcnNpb24iOiIxLjAiLCJzdWJzY3JpcHRpb25UaWVyIjoiVW5saW1pdGVkIn0seyJzdWJzY3JpYmVyVGVuYW50RG9tYWluIjoiY2FyYm9uLnN1cGVyIiwibmFtZSI6IlF1b3Rlcy1LU0VDIiwiY29udGV4dCI6IlwvYXBpbVwvcXVvdGVzXC92MS4wIiwicHVibGlzaGVyIjoiYWRtaW4iLCJ2ZXJzaW9uIjoidjEuMCIsInN1YnNjcmlwdGlvblRpZXIiOiJVbmxpbWl0ZWQifV0sImlhdCI6MTYzNjg2MDk1MCwianRpIjoiNTA0ZDYxYTItMGE2Ni00OTk2LWFlNDItYzhkMWU1M2Y1NWI4In0=.mfOgRZmaAFYA4zKyN2NorwzadTFgcUSFsusP2lrWZUR6IBUTLjx00hQ97aLJtMYfyZQY0uWBRfgOxUocYUVs2LS3pa_gazN10lXa2vxiltlBFQThtoLf4Lv4Gew4GlXjWS-ZoFUaYJTJhfcEM3XEKqOYTujpdGF-N1TGmpxmAWUAiNWvbT4C4nDfwPZ5KWDB9ITHkAYWMmQ9JsiFzyrYX_kJivQ8MPFHyVUKSI4hBHCxAOBWJx_p9hib0Ua_3fy82jibnToWJd8sGOQ7UPz90mgaGdOSxGjsEWEdiJwaetHaiNlH8egskhM4Ve6MNn3YJvlaENDPSfzXnk8bnX-K5A==";
let sessionToken = "";

let default_headers = {
  'userid': userId,
  'consumerKey': consumerKey,
  'ip': '0.0.0.0',
  'appId': appId,
  'Authorization': 'Bearer ' + token
};

function login(credentials) {
  return new Promise((resolve, reject) => {
    var options = {
      'method': 'GET',
      'url': 'https://tradeapi.kotaksecurities.com/apim/session/1.0/session/init',
      'headers': default_headers,
      json: true
    };

    request(options, function (error, response) {
      if (error) throw new Error(error);
      // console.log(response.body);

      if (response.body && response.body.Success && response.body.Success.clientType == 'ONLINE') {
        options.method = "POST";
        options.url = "https://tradeapi.kotaksecurities.com/apim/session/1.0/session/login/userid";
        options.body = credentials;

        request(options, function (error, response) {
          if (error) throw new Error(error);
          // console.log(response.body);

          if (response.body && response.body.Success && response.body.Success.oneTimeToken) {
            options.url = "https://tradeapi.kotaksecurities.com/apim/session/1.0/session/2FA/oneTimeToken";
            options.headers.oneTimeToken = response.body.Success.oneTimeToken;
            options.body = {
              "userid": credentials.userid,
            };

            request(options, function (error, response) {
              if (error) throw new Error(error);
              // console.log(response.body);

              if (response.body && response.body.success && response.body.success.sessionToken) {
                sessionToken = response.body.success.sessionToken;
                default_headers.sessionToken = sessionToken;
                resolve(true);
              } else resolve(false);
            });
          } else resolve(false);
        });
      } else resolve(false);
    });
  });
}

function getMargins() {
  return new Promise((resolve, reject) => {
    var options = {
      'method': 'GET',
      'url': 'https://tradeapi.kotaksecurities.com/apim/margin/1.0/margin',
      'headers': default_headers,
      json: true
    };

    request(options, function (error, response) {
      try {
        resolve(response.body.Success);
      } catch (err) {
        console.log(err);
        resolve([]);
      }
    });
  });
}

function getPositions() {
  return new Promise((resolve, reject) => {
    var options = {
      'method': 'GET',
      'url': 'https://tradeapi.kotaksecurities.com/apim/positions/1.0/positions/open',
      'headers': default_headers,
      json: true
    };

    request(options, function (error, response) {
      try {
        resolve(response.body.Success);
      } catch (err) {
        console.log(err);
        resolve([]);
      }
    });
  });
}

function placeOrder(type = 'normal', orderParams) {
  return new Promise((resolve, reject) => {
    var options = {
      'method': 'POST',
      'url': 'https://tradeapi.kotaksecurities.com/apim/orders/1.0/order/' + type,
      'headers': default_headers,
      body: orderParams,
      json: true
    };

    request(options, function (error, response) {
      try {
        console.log(response.body);
        resolve(response.body.Success);
      } catch (err) {
        console.log(err);
        resolve([]);
      }
    });
  });
}

async function init() {
  let resp = await login({
    "userid": "Dangat1",
    "password": "Deepak@78"
  });

  let positions = await getPositions();
  let margins = await getMargins();
  console.log(resp, positions, JSON.stringify(margins, null, 2));

  // let order_1 = await placeOrder('mtf', {
  //   instrumentToken: 38328,
  //   "transactionType": "BUY",
  //   "product": "NORMAL",
  //   "quantity": 25,
  //   "price": 0,
  //   "validity": "GFD",
  //   "variety": "REGULAR",
  //   "tag": "test_order",
  //   "disclosedQuantity": 0,
  //   "triggerPrice": 0
  // });
  // console.log(order_1);
  // let order_2 = await placeOrder('mtf', {
  //   instrumentToken: 38328,
  //   "transactionType": "SELL",
  //   "product": "NORMAL",
  //   "quantity": 25,
  //   "price": 0,
  //   "validity": "GFD",
  //   "variety": "REGULAR",
  //   "tag": "test_order",
  //   "triggerPrice": 0,
  //   "disclosedQuantity": 0
  // });
  // console.log(order_2);
}

init();
