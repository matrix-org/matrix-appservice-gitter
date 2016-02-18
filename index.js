/* BEGIN LEGACY */
var request = require('request')
var legacyGitterClient = require('./gitter.js')

// Needs to be shared
var gitterHeaders;

function startGitterBridge(config, onGitterMessage) {
  var gitter = legacyGitterClient(config.gitter_api_key)
  gitterHeaders = {
    'Accept': 'application/json',
    'Authorization': 'Bearer ' + config.gitter_api_key
  }

  request({url: 'https://api.gitter.im/v1/user', headers: gitterHeaders, json: true}, function (err, res, json) {
    if (err) return console.log(err)
    var gitterName = json[0].username
    var gitterUserId = json[0].id

    config.rooms.forEach(function(room) {
      request.post({ url: 'https://api.gitter.im/v1/rooms', headers: gitterHeaders, json: {uri: room.gitter_room} }, function (err, req, json) {
        if (err) return console.log(err)
        room.gitterRoomId = json.id

        gitter.subscribe('/api/v1/rooms/' + room.gitterRoomId + '/chatMessages', gitterMessage, {})

        function gitterMessage (data) {
          if (data.operation !== 'create') return
          var message = data.model
          if (!message.fromUser) return
          var userName = message.fromUser.username
          if (userName === gitterName) return

          console.log('gitter->' + room.gitterRoomId + ' from ' + userName + ':', message.text)

          onGitterMessage(room, userName, message.text)

          // mark message as read by bot
          request.post({
            url: 'https://api.gitter.im/v1/user/' + gitterUserId + '/rooms/' + room.gitterRoomId + '/unreadItems',
            headers: gitterHeaders,
            json: {chat: [ message.id ]}
          })
        }
      })
    })
  })
}
/* END LEGACY */

var Gitter = require('node-gitter');

var Cli = require("matrix-appservice-bridge").Cli;
var Bridge = require("matrix-appservice-bridge").Bridge;
var AppServiceRegistration = require("matrix-appservice-bridge").AppServiceRegistration;

function runBridge(port, config) {
  var gitter = new Gitter(config.gitter_api_key);

  var bridge = new Bridge({
    homeserverUrl: config.matrix_homeserver,
    domain: "localhost",
    registration: "gitter-registration.yaml",
    controller: {
      onUserQuery: function(queriedUser) {
        return {}; // auto-provision users with no additonal data
      },

      onEvent: function(req, context) {
        var event = req.getData();
        if (event.type !== "m.room.message" || !event.content) {
          return;
        }

        console.log('matrix->' + event.room_id + ' from ' + event.user_id + ':', event.content.body)

        var roomConfig = config.rooms.find(function (r) {
          return r.matrix_room_id == event.room_id
        })

        if (!roomConfig) {
          console.log("  Wasn't expecting this room; ignore");
          return;
        }

        // gitter supports Markdown. We'll use that to apply a little formatting
        // to make understanding the text a little easier
        var text = '*<' + event.user_id + '>*: ' + event.content.body

        gitter.rooms.find(roomConfig.gitterRoomId).then(function (room) {
          room.send(text);
        });

        return;
      }
    }
  });
  console.log("Matrix-side listening on port %s", port);

  startGitterBridge(config, function (room, userName, text) {
    var intent = bridge.getIntent('@gitter_' + userName + ':' + config.matrix_user_domain);
    // TODO(paul): this sets the profile name *every* line. Surely there's a way to do
    // that once only, lazily, at user account creation time?
    intent.setDisplayName(userName + ' (Gitter)');
    intent.sendText(room.matrix_room_id, text);
  })

  bridge.run(port, config);
}

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
  run: runBridge
}).run();
