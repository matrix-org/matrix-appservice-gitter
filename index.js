var request = require('request')
var gitterClient = require('./gitter.js')

var bridge;

var opts = {
  gitterApiKey: process.env['GITTERBOT_APIKEY'],
  gitterRoom: process.env['GITTERBOT_GITTER_ROOM'],
  matrixUserDomain: 'localhost:8080',
  matrixRoom: '!KzGaZKsadZKVAYCzjl:localhost:8080'
}

if (!(opts.gitterApiKey && opts.gitterRoom)) {
  console.error('You need to set the config env variables (see readme.md)')
  process.exit(1)
}

var gitter = gitterClient(opts.gitterApiKey)
var headers = {
  'Accept': 'application/json',
  'Authorization': 'Bearer ' + opts.gitterApiKey
}

function log (message) {
  console.error(message)
}

request.post({ url: 'https://api.gitter.im/v1/rooms', headers: headers, json: {uri: opts.gitterRoom} }, function (err, req, json) {
  if (err) return log(err)
  var gitterRoomId = json.id
  var postGitterMessageUrl = 'https://api.gitter.im/v1/rooms/' + gitterRoomId + '/chatMessages'

  request({url: 'https://api.gitter.im/v1/user', headers: headers, json: true}, function (err, res, json) {
    if (err) return log(err)
    var gitterName = json[0].username
    var gitterUserId = json[0].id
    log('Gitterbot ' + gitterName + ' on channel ' + opts.gitterRoom + '(' + gitterRoomId + ')')

    gitter.subscribe('/api/v1/rooms/' + gitterRoomId + '/chatMessages', gitterMessage, {})

    function gitterMessage (data) {
      if (data.operation !== 'create') return
      var message = data.model
      if (!message.fromUser) return
      var userName = message.fromUser.username
      if (userName === gitterName) return

      console.log('gitter->' + gitterRoomId + ' from ' + userName + ':', message.text)

      var intent = bridge.getIntent('@gitter_' + userName + ':' + opts.matrixUserDomain)
      intent.sendText(opts.matrixRoom, message.text)

      // mark message as read by bot
      request.post({
        url: 'https://api.gitter.im/v1/user/' + gitterUserId + '/rooms/' + gitterRoomId + '/unreadItems',
        headers: headers,
        json: {chat: [ message.id ]}
      })
    }

    /*
     * TODO: relay messages from Matrix using something like:
       request.post({url: postGitterMessageUrl, headers: headers, json: {text: text}})
    */
  })
})

var Cli = require("matrix-appservice-bridge").Cli;
var Bridge = require("matrix-appservice-bridge").Bridge;
var AppServiceRegistration = require("matrix-appservice-bridge").AppServiceRegistration;

new Cli({
  port: 9000,
  registrationPath: "gitter-registration.yaml",
  generateRegistration: function(reg, callback) {
    reg.setHomeserverToken(AppServiceRegistration.generateToken());
    reg.setAppServiceToken(AppServiceRegistration.generateToken());
    reg.setSenderLocalpart("gitterbot");
    reg.addRegexPattern("users", "@gitter_.*", true);
    callback(reg);
  },
  run: function(port, config) {
    bridge = new Bridge({
      homeserverUrl: "http://localhost:7680",
      domain: "localhost",
      registration: "gitter-registration.yaml",
      controller: {
        onUserQuery: function(queriedUser) {
          return {}; // auto-provision users with no additonal data
        },

        onEvent: function(request, context) {
          return; // we will handle incoming matrix requests later
        }
      }
    });
    console.log("Matrix-side listening on port %s", port);
    bridge.run(port, config);
  }
}).run();
