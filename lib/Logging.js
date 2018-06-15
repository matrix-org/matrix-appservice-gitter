const winston = require("winston");
require('winston-daily-rotate-file');

class Logging {
    constructor() {
        this.loggers = new Map();
        this.transports = null;
    }

    /*
        config:
            console: "error|warn|info|debug|off"
            files: {
                "abc.log" => "error|warn|info|debug|off"
            }
            maxFiles: 5
    */
    Configure(config) {
        let updatingLoggers = false;
        const timestampFn = function() {
            return new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
        };
        const formatterFn = function(opts) {
            return opts.timestamp() + ' ' +
            opts.level.toUpperCase() + ':' +
            (opts.meta && opts.meta.loggerName ? opts.meta.loggerName : "") + ' ' +
            (undefined !== opts.message ? opts.message : '');
        };
        // if (this.transports.length > 0) {
        //     updatingLoggers = true;
        //     this.transports.forEach((transport) => {
        //         this.loggers.forEach((wrapper, name) => {
        //             wrapper.logger.remove(transport);
        //         });
        //     });
        // }
        this.transports = [];
        if (config.console != undefined && config.console != "off") {
            this.transports.push(new (winston.transports.Console)({
                json: false,
                name: "console",
                timestamp: timestampFn,
                formatter: formatterFn,
                level: config.console
            }));
        }

        if(config.files == undefined) {
            return;
        }

        let i = 0;
        for (let file of config.files) {
            const filename = Object.keys(file)[0];
            const level = file[filename];
            i++;
            this.transports.push(new (winston.transports.DailyRotateFile)({
                filename,
                datePattern: "YYYY-MM-DD",
                name: `logfile` + i,
                formatter: formatterFn,
                level,
                timestamp: timestampFn,
                maxFiles: config.maxFiles > 0 ? config.maxFiles : undefined
            }));
        }

        this.loggers.forEach((wrapper, name) => {
            wrapper.SwapIn(this.createLogger(name));
        });
    }

    Get(name) {
        if(!this.loggers.has(name)) {
            const wrapper = new LogWrapper()
            this.loggers.set(name, wrapper);
            if (this.transports != null) {
                wrapper.SwapIn(this.createLogger(name));
            }
        }
        return this.loggers.get(name);
    }

    createLogger(name) {
        const logger =  new (winston.Logger)({
            transports: this.transports,
            // winston doesn't support getting the logger category from the
            // formatting function, which is a shame. Instead, write a rewriter
            // which sets the 'meta' info for the logged message with the loggerName
            rewriters: [
                function(level, msg, meta) {
                    if (!meta) { meta = {}; }
                    meta.loggerName = name;
                    return meta;
                }
            ]
        });
        logger.info("Created new logger!");
        return logger;
    }
}

class LogWrapper {
    constructor() {
        this.logger = null;
        this.messages = [];
    }

    SwapIn(logger) {
        this.logger = logger;
    }

    debug(...message) {this._log(message, 'debug')};

    info(...message) {this._log(message, 'info')};

    warn(...message) {this._log(message, 'warn')};

    error(...message) {this._log(message, 'error')};

    _log(message, type) {
        if(this.logger == null) {
            this.messages.push([{type:'error', message}]);
            return;
        } else {
            // Flush out any messages
            while (this.messages.length > 0) {
                const msg = this.messages[0];
                this.logger[msg.type](...msg.message);
                this.messages.splice(0,1);
            }
        }
        this.logger[type](...message);
    }
}

/* Setup a basic instance first, which will become a new instance
   when things go wrong.
*/
let instance = new Logging();

module.exports = {
    Get: (name) => {
        return instance.Get(name);
    },

    Configure: (config) => {
        instance.Configure(config);
    }
}
