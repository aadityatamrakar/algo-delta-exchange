var ClientOAuth2 = require('client-oauth2');
var request = require('request');

module.exports = function (app) {
  var router = app.loopback.Router();

  async function getClientInfo(access_token) {
    return new Promise((resolve, reject) => {
      var options = {
        'method': 'GET',
        'url': 'https://klevertrade.arhamwealth.com/api/v1/user/trading_info',
        'headers': {
          'Authorization': 'Bearer ' + access_token,
          'Content-Type': 'application/json'
        },
        json: true
      };
      request(options, function (error, response) {
        if (error) console.log(error);
        resolve(response.body);
      });
    });
  }

  // Credentials come from the environment. They were previously hardcoded here,
  // which meant a live broker OAuth client secret sat in git history AND was
  // loaded on every app boot (this file is in server/boot/, so loopback-boot
  // executes it in every one of the ~150 processes). See .env.example.
  //
  // NOTE: the previously-committed secret must be treated as compromised and
  // rotated at the broker — removing it from the source does not un-leak it.
  var TRADELAB_CLIENT_ID = process.env.TRADELAB_CLIENT_ID;
  var TRADELAB_CLIENT_SECRET = process.env.TRADELAB_CLIENT_SECRET;

  if (!TRADELAB_CLIENT_ID || !TRADELAB_CLIENT_SECRET) {
    // Warn and skip route registration rather than throwing: a missing optional
    // broker integration must not prevent the app (or any strategy process)
    // from booting.
    console.warn(
      '[tradelab_auth] TRADELAB_CLIENT_ID / TRADELAB_CLIENT_SECRET not set — ' +
      'Tradelab/Arham OAuth routes are DISABLED. See .env.example.'
    );
    return;
  }

  var arhamAuth = new ClientOAuth2({
    clientId: TRADELAB_CLIENT_ID,
    clientSecret: TRADELAB_CLIENT_SECRET,
    accessTokenUri: 'https://klevertrade.arhamwealth.com/oauth2/token',
    authorizationUri: 'https://klevertrade.arhamwealth.com/oauth2/auth',
    redirectUri: 'https://instacorpsecurities.com/tradelab_response',
    // redirectUri: 'http://127.0.0.1/',
    scopes: ['orders', 'holdings'],
    state: "{\"param\": \"value\"}"
  });

  router.get('/tradelab_auth', (req, res) => {
    res.redirect(arhamAuth.code.getUri());
  });

  router.get('/tradelab_response', (req, res) => {
    let loginUrl = req.originalUrl;
    // loginUrl = 'http://127.0.0.1/' + loginUrl.substr(loginUrl.indexOf('?'))

    let TradelabAccount = app.models.sparkAccount;
    try {
      arhamAuth.code.getToken(loginUrl)
        .then(async function (user) {
          console.log(user);
          if (user && user.accessToken) {
            let clientInfo = await getClientInfo(user.accessToken);
            if (clientInfo && clientInfo.status == 'success') {
              let account = await TradelabAccount.findOne({ 'credentials.user_id': clientInfo.data.client_id });
              account.credentials.token = user.accessToken;
              account.save();
              console.log(clientInfo);
              res.send("Success!");
            } else res.send("Login Failed!");
          } else res.send("Login Failed!");
        }).catch(function (err) {
          console.log(err);
          res.send("Login Failed!");
        });
    } catch (er) {
      console.log(er);
      res.send("Something went wrong!");
    }
  });

  router.post('/tradelab_response', (req, res) => {
    console.log('POST', req);
    res.send("OK");
  });

  // REMOVED 2026-07-25: an unauthenticated `GET /add_the_boss` route that created
  // a client with realm 'admin', superadmin:true, execution:true, live:true at a
  // fixed _id. Anyone able to reach this port could mint a superadmin account by
  // visiting one URL, and it was registered on every boot.
  //
  // If a bootstrap-admin mechanism is genuinely needed, it belongs in a one-off
  // CLI script run by an operator with database access — never an HTTP endpoint.
  //
  // Any admin client created by the old route should be audited: check the
  // `client` collection for _id 63478c004da191196aec5906 / username 8103704575
  // and confirm it is legitimately yours.

  app.use(router);
}
