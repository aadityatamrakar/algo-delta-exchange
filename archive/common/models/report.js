'use strict';

module.exports = function (Report) {

	// Report.daily_min_max = function (strategy, cb) {
	// 	db.getCollection('strategyPNL').aggregate([
	// 		{ $match: { strategy: strategy } },
	// 		{ $group: { _id: { $dateToString: { date: "$ts", format: "%Y-%m-%d" } }, maxPnl: { $max: "$m2m" }, minPnl: { $min: "$m2m" } } },
	// 		{ $sort: { maxPnl: 1 } }
	// 	])
	// };

	// Report.remoteMethod("daily_min_max", {
	// 	http: {
	// 		verb: "post"
	// 	},
	// 	accepts: [{
	// 		arg: "strategy",
	// 		type: "string"
	// 	}],
	// 	returns: {
	// 		type: "object",
	// 		root: true
	// 	}
	// });

};
