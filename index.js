const Cli = require("matrix-appservice-bridge").Cli;
const AppServiceRegistration = require("matrix-appservice-bridge").AppServiceRegistration;
const Main = require("./lib/Main");
const ConfigureLogging = require("./lib/Logging.js").Configure;
const log = require("./lib/Logging.js").Get("index.js");
const path = require("path");

new Cli({
    registrationPath: "gitter-registration.yaml",
    bridgeConfig: {
        schema: path.join(__dirname, "config/gitter-config-schema.yaml"),
    },
    generateRegistration: function(reg, callback) {
        reg.setHomeserverToken(AppServiceRegistration.generateToken());
        reg.setAppServiceToken(AppServiceRegistration.generateToken());
        reg.setSenderLocalpart("gitterbot");
        reg.addRegexPattern("users", "@gitter_.*", true);
        reg.addRegexPattern("aliases", "#gitter_.*", true);
        reg.setId("gitter");
        callback(reg);
    },
    run: function (port, config, reg) {
        log.info("Matrix-side listening on port %s", port);
        if (config.logging) {
            ConfigureLogging(config.logging);
        } else {
            ConfigureLogging({console:"debug"});
        }
        (new Main(config, reg)).run(port);
    },
}).run();
