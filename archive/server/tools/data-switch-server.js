const SocketIO = require("socket.io");

const io = new SocketIO.Server(8080);

io.on("connection", (socket) => {
  // console.log('new connection: ' + socket.id);

  socket.on('join_room', function (room_name) {
    socket.join(room_name);
  });
  socket.on('emit_room', function (room_name, topic, data) {
    socket.to(room_name).emit(topic, data);
  });
  socket.on('leave_room', function (room_name) {
    socket.leave(room_name);
  });
});

/*

// subscribe all stocks
Link.emit("emit_room", "PFA", "action", {type: "stocks", data: '{"action":"subscribe","params":"A.*"}'});

*/
