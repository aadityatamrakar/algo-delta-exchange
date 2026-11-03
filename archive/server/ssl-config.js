var path = require('path'),
fs = require("fs");
exports.privateKey = fs.readFileSync('/etc/letsencrypt/live/bot.algomaker.in/privkey.pem');
exports.certificate = fs.readFileSync('/etc/letsencrypt/live/bot.algomaker.in/fullchain.pem');
