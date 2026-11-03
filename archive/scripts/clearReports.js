const app = require('./server/server.js');
const Report = app.models.report;

function clearReport(strategy) {
  Report.destroyAll({
    platform: 'paper',
    strategy: strategy,
  }, function () {
    console.log('Reports Deleted');
  });
}

clearReport('Ford');