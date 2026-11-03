const notify = require('./../lib/notify');
const bodyParser = require('body-parser');

module.exports = function (app) {
  var router = app.loopback.Router();

  router.get('/tradingview', (req, res) => {
    res.send("Hello Tradingview!");
  });

  router.post('/tradingview', (req, res) => {
    try {
      const data = req.body;
      // notify(data);
      console.log(data);
      res.send("ok");
    } catch (er) {
      console.log(er);
      res.send("ok");
      // res.send(er);
    }
  });
  
  app.use(bodyParser.text({ type: 'text/plain' }));
  app.use(router);
}
