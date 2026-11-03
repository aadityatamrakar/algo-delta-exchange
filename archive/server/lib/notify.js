let request = require('request');

const config = [{
  channel: "@SMPAlerts",
  channelId: -1001499232615,
  key: '1719025313:AAEj_-VnXVruPsXtAOLWBMjYpf0uZQ64-3A',
  username: "SMPAlertBot"
}];

async function notify(message, configIdx = 0) {
  return new Promise((resolve, reject) => {
    if (message) {
      sendMessage(config[configIdx], encodeURIComponent(message))
        .then(function (resp) {
          console.log(resp);
          resolve();
        }, err => {
          // console.log(err);
          resolve(err);
        });
    }
  });
}

function sendMessage(config, message) {
  return new Promise((resolve, reject) => {
    // console.time('notify')
    let options = {
      method: "GET",
      url: `https://api.telegram.org/bot${config.key}/sendMessage?parse_mode=HTML&chat_id=${config.channelId?config.channelId:config.channel}&text=${message}`,
      gzip: true,
      headers: {
        "Connection": "keep-alive"
      }
    }
    request.get(options, function (err, resp, body) {
      // console.timeEnd('notify')
      if (err) reject(err);
      else resolve(body)
    })
  });
}

module.exports = notify;
