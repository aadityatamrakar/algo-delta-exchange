var request = require('request');

function sendReq(authToken, key, value) {
  return new Promise((resolve, reject) => {
    try {
      var options = {
        'method': 'GET',
        'url': `https://api.tradetron.tech/api?auth-token=${authToken}&key=${key}&value=${value}`
      };
      request(options, function (error, response) {
        if (error) {
          resolve({
            status: false,
            body: error
          });
        } else {
          resolve({
            status: true,
            body: response.body
          });
        }
      });
    } catch (err) {
      console.log(err);
      resolve({
        status: false,
        body: err
      })
    }
  });
}


module.exports = sendReq;
