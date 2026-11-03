'use strict';

module.exports = function (Payment) {

  Payment.observe('before save', function (ctx, next) {
    var Client = Payment.app.models.client;
    if (ctx.isNewInstance) {
      try {
        let phone = ctx.instance.payload.payment.entity.notes.phone;
        Client.findOne({
          where: {
            username: phone
          }
        }).then(function (client) {
          if (client) {
            client.live = true;
            client.save().then(next);
          } else next();
        })
        next();
      } catch (err) {
        console.log(err);
        next();
      }
    } else {
      next();
    }
  });
};
