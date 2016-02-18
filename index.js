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

  // We have to find out our own gitter user ID so we can ignore reflections of
  // messages we sent
  gitter.currentUser().then(function (u) {
    var gitterUserId = u.id;

    function onNewGitterRoom(roomConfig) {
      var roomName = roomConfig.gitter_room;

      gitter.rooms.join(roomName).then(function (room) {
        var events = room.streaming().chatMessages();

        // TODO(paul): Terrible hack to make the other join path work
        roomConfig.gitterRoomId = room.id;

        events.on('chatMessages', function(message) {
          if (message.operation !== 'create' ||
              !message.model.fromUser) {
            return;
          }

          var fromUser = message.model.fromUser;

          if(fromUser.id == gitterUserId) {
            // Ignore a reflection of my own messages
            return;
          }

          console.log('gitter->' + roomName + ' from ' + fromUser.username + ':', message.model.text)

          var intent = bridge.getIntent('@gitter_' + fromUser.username + ':' + config.matrix_user_domain);
          // TODO(paul): this sets the profile name *every* line. Surely there's a way to do
          // that once only, lazily, at user account creation time?
          intent.setDisplayName(fromUser.displayName + ' (Gitter)');

          // TODO(paul): We could send an HTML message if we looked in message.model.html
          intent.sendText(roomConfig.matrix_room_id, message.model.text);
        });
      });
    }

    config.rooms.forEach(onNewGitterRoom);
  });

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
