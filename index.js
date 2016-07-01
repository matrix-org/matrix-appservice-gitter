var Cli = require("matrix-appservice-bridge").Cli;
var AppServiceRegistration = require("matrix-appservice-bridge").AppServiceRegistration;

var MatrixGitterBridge = require("./lib/MatrixGitterBridge");

new Cli({
  registrationPath: "gitter-registration.yaml",
  bridgeConfig: {
    schema: "config/gitter-config-schema.yaml",
  },
  generateRegistration: function(reg, callback) {
    reg.setHomeserverToken(AppServiceRegistration.generateToken());
    reg.setAppServiceToken(AppServiceRegistration.generateToken());
    reg.setSenderLocalpart("gitterbot");
    reg.addRegexPattern("users", "@gitter_.*", true);
    callback(reg);
  },
  run: function(port, config) {
    console.log("Matrix-side listening on port %s", port);
    (new MatrixGitterBridge(config)).run(port);
  },
}).run();
