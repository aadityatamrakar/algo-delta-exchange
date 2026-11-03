const os = require('os');
const fs = require('fs');
const MongoClient = require('mongodb').MongoClient;

class DBUtils {
    constructor() {
        this.dbo;
        this.db_connection;
        this.db_conf = require(__dirname+"/../conf/db_conf.json");
    }
    readJsonFile(path) {
        let data = fs.readFileSync(path);
        return this.getJson(data);
    }

    getJson(data) {
        try {
            return JSON.parse(data);
        } catch (err) {
            return false;
        }
    }

    async connect_mongo(options) {
        if (typeof options == 'undefined') options = this.db_conf[this.db_conf['current']];
        return new Promise((resolve, reject) => {
            if (!options.host) {
                options.host = 'localhost'
            }
            if (!options.port) {
                options.port = '27017'
            }
            if(typeof options.url == 'undefined') options.url = `mongodb://${options.host}:${options.port}/${options.db}`;
            let self = this;
            MongoClient.connect(options.url, { useNewUrlParser: true }, function (err, db) {
                if (err) reject(err);
                self.db_connection = db;
                self.selectDB(options.db);
                resolve(db);
            });
        });
    }

    getModel(collection_name) {
        return this.dbo.collection(collection_name);
    }

    selectDB(db_name) {
        this.dbo = this.db_connection.db(db_name);
        return this.dbo;
    }

    getDBConnection() {
        return this.db_connection;
    }

    async pause(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    convertToISTTimeZone(date) {
        var currentTime = new Date(date);
        var currentOffset = currentTime.getTimezoneOffset();
        var ISTOffset = 330; // IST offset UTC +5:30
        return new Date(currentTime.getTime() + (ISTOffset + currentOffset) * 60000).toLocaleString();
    }
    
    convertToIST(date) {
        var currentTime = new Date(date);
        var currentOffset = currentTime.getTimezoneOffset();
        var ISTOffset = 330; // IST offset UTC +5:30
        var t = new Date(currentTime.getTime() + (ISTOffset + currentOffset) * 60000)
        t.setSeconds(0);
        t.setMilliseconds(0);
        return `${t.toISOString().substr(0,10)}T${t.toTimeString().substr(0, 8)}+0530`;
    }

    convertToESTTimeZone(date) {
        //EST
        var offset = -5.0
        var clientDate = new Date(date);
        var utc = clientDate.getTime() + (clientDate.getTimezoneOffset() * 60000);
        var serverDate = new Date(utc + (3600000 * offset));
        return serverDate.toLocaleString();
    }

    cpuAverage() {
        var totalIdle = 0,
            totalTick = 0;
        var cpus = os.cpus();
        for (var i = 0, len = cpus.length; i < len; i++) {
            var cpu = cpus[i];
            Object.keys(cpu.times).forEach(k => {
                totalTick += cpu.times[k];
            })
            totalIdle += cpu.times.idle;
        }
        return {
            idle: totalIdle / cpus.length,
            total: totalTick / cpus.length
        };
    }
    cpuUsage(startMeasure, endMeasure) {
        var idleDifference = endMeasure.idle - startMeasure.idle;
        var totalDifference = endMeasure.total - startMeasure.total;
        var percentageCPU = 100 - ~~(100 * idleDifference / totalDifference);
        return percentageCPU;
    }

}

module.exports = DBUtils;