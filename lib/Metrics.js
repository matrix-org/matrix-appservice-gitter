"use strict";

// Optionally try to load qrusage but don't depend on it
var qrusage;
try {
    qrusage = require("qrusage");
}
catch (e) {}

var fs = require("fs");

function Metrics() {
    // Only attempt to load these dependencies if metrics are enabled
    var Prometheus = require("prometheus-client");

    var client = this._client = new Prometheus();

    this._gauges = []; // just a list, order doesn't matter
    this._counters = {};

    // Register some built-in process-wide metrics
    // See also
    //   https://prometheus.io/docs/instrumenting/writing_clientlibs/#standard-and-runtime-collectors

    var rss_gauge = this.addGauge({
        namespace: "process",
        name: "resident_memory_bytes",
        help: "Resident memory size in bytes",
    });
    // TODO(paul): report process_virtual_memory_bytes ?

    var heap_size_gauge = this.addGauge({
        namespace: "process",
        name: "heap_bytes",
        help: "Total size of Node.js heap in bytes",
    });
    var heap_used_gauge = this.addGauge({
        namespace: "nodejs",
        name: "heap_used_bytes",
        help: "Used size of Node.js heap in bytes",
    });

    // legacy name
    this.addGauge({
        name: "process_mem",
        help: "memory usage in bytes",
        refresh: function(gauge) {
            var usage = process.memoryUsage();

            Object.keys(usage).forEach((key) => {
                gauge.set({type: key}, usage[key]);
            });

            rss_gauge.set({}, usage.rss);
            heap_size_gauge.set({}, usage.heapTotal);
            heap_used_gauge.set({}, usage.heapUsed);
        }
    });

    // Node versions >= 6.2.0 have cpuUsage natively
    var cpuUsage = process.cpuUsage ||
        // otherwise, see if we can load it out of qrusage
        (qrusage && qrusage.cpuUsage);

    if (cpuUsage) {
        this.addGauge({
            name: "process_cpu",
            help: "CPU usage in microseconds",
            refresh: function(gauge) {
                var cpuusage = cpuUsage();

                gauge.set({type: "user"}, cpuusage.user);
                gauge.set({type: "system"}, cpuusage.system);
            }
        });
    }
    else {
        console.log("Unable to report cpuUsage in this version");
    }

    this.addGauge({
        namespace: "process",
        name: "open_fds",
        help: "Number of open file descriptors",
        refresh: function(gauge) {
            var fds = fs.readdirSync("/proc/self/fd");

            // subtract 1 due to readdir handle itself
            gauge.set(null, fds.length - 1);
        }
    });

    this.addGauge({
        namespace: "process",
        name: "max_fds",
        help: "Maximum number of open file descriptors allowed",
        refresh: function(gauge) {
            var limits = fs.readFileSync("/proc/self/limits");
            limits.toString().split(/\n/).forEach((line) => {
                if (!line.match(/^Max open files /)) return;

                // "Max", "open", "files", $SOFT, $HARD, "files"
                gauge.set({}, line.split(/\s+/)[3]);
            });
        }
    });

    // TODO(paul): report process_start_time_seconds

    this.refresh();
};

Metrics.prototype.refresh = function() {
    this._gauges.forEach((i) => i.refresh && i.refresh(i.gauge));
};

Metrics.prototype.addGauge = function(opts) {
    var refresh = opts.refresh;
    var gauge = this._client.newGauge({
        namespace: opts.namespace || "bridge",
        name: opts.name,
        help: opts.help,
    });

    this._gauges.push({
        gauge: gauge,
        refresh: refresh,
    });

    return gauge;
};

Metrics.prototype.addCounter = function(opts) {
    this._counters[opts.name] = this._client.newCounter({
        namespace: opts.namespace || "bridge",
        name: opts.name,
        help: opts.help,
    });
};

Metrics.prototype.incCounter = function(name, labels) {
    if (!this._counters[name]) {
        console.log("TODO: missing metric " + name);
        return;
    }

    this._counters[name].increment(labels);
};

Metrics.prototype.addAppServicePath = function(bridge) {
    var metricsFunc = this._client.metricsFunc();

    bridge.addAppServicePath({
        method: "GET",
        path: "/metrics",
        handler: (req, res) => {
            this.refresh();
            return metricsFunc(req, res);
        },
    });
};

var HOUR = 3600;
var DAY  = HOUR * 24;

function AgeCounters() {
    this["1h"] = 0;
    this["1d"] = 0;
    this["7d"] = 0;
    this["all"] = 0;
}
Metrics.AgeCounters = AgeCounters;

AgeCounters.prototype.bump = function(age) {
    if (age < HOUR   ) this["1h"]++;
    if (age < DAY    ) this["1d"]++;
    if (age < DAY * 7) this["7d"]++;

    this["all"]++;
};

AgeCounters.prototype.setGauge = function(gauge, morelabels) {
    Object.keys(this).forEach((age) => {
        // I wish I could use spread expressions
        var labels = {age: age};
        Object.keys(morelabels).forEach((k) => labels[k] = morelabels[k]);

        gauge.set(labels, this[age]);
    });
};

module.exports = Metrics;
