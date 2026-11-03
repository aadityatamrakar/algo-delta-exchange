module.exports = function (app) {
  var Role = app.models.Role;
  var Client = app.models.client;
  Role.registerResolver("admin", function (role, context, cb) {
    function reject() {
      process.nextTick(function () {
        cb(null, false);
      });
    }
    var userId = context.accessToken.userId || false;
    if (userId) {
      Client.findById(userId).then(user => {
        if (user && user.admin === true) {
          cb(null, true);
        } else reject();
      });
    } else reject();
  });

  Role.registerResolver("superadmin", function (role, context, cb) {
    function reject() {
      process.nextTick(function () {
        cb(null, false);
      });
    }
    var userId = context.accessToken.userId || false;
    if (userId) {
      Client.findById(userId).then(user => {
        if (user && user.superadmin === true) {
          cb(null, true);
        } else reject();
      });
    } else reject();
  });
};
