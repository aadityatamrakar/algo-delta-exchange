const SocketIOClient = require('socket.io-client');
const SOCKET_SERVER = "localhost:8080";
const SwitchWS = new SocketIOClient.io('ws://' + SOCKET_SERVER);

module.exports = SwitchWS;
