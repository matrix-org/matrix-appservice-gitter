var Promise = require("bluebird");

var Gitter = require('node-gitter');

var Cli = require("matrix-appservice-bridge").Cli;
var Bridge = require("matrix-appservice-bridge").Bridge;
var AppServiceRegistration = require("matrix-appservice-bridge").AppServiceRegistration;

var MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;

// TODO: maybe we'll extend it later
var GitterRoom = require("matrix-appservice-bridge").RemoteRoom;

var BridgedRoom = require("./lib/BridgedRoom");

function runBridge(port, config) {
  var gitter = new Gitter(config.gitter_api_key);

  var bridgedRoomsByMatrixId = {};

  var bridge = new Bridge({
    homeserverUrl: config.matrix_homeserver,
    domain: config.matrix_user_domain,
    registration: "gitter-registration.yaml",
    controller: {
      onUserQuery: function(queriedUser) {
        return {}; // auto-provision users with no additonal data
      },

      onEvent: function(req, context) {
        var event = req.getData();

        if (event.type == "m.room.member" &&
            event.state_key == bridge.getBot().getUserId()) {
          var membership = event.content.membership;
          if (membership == "invite") {
            onBotInvited(event.room_id);
          }
          else if (membership == "join") {
            onBotJoined(event.room_id);
          }
          else if (membership == "leave") {
            // TODO: "leave" events might mean we left the room, or got kicked
            //   while still in invite state - i.e. invite was cancelled
            //   before we joined.
            onBotLeft(event.room_id);
          }
          else {
            console.log('matrix member event for myself to state ' + membership + 
                        ' from state ', event);
          }
          return;
        }

        if (event.type !== "m.room.message" || !event.content) {
          return;
        }

        if (event.sender == bridge.getBot().getUserId()) {
          return;
        }

        console.log('matrix->' + event.room_id + ' from ' + event.user_id + ':', event.content.body)

        var handled = false;

        if (config.matrix_admin_room && event.room_id == config.matrix_admin_room) {
          onMatrixAdminMessage(event);
          handled = true;
        }

        var bridgedRoom = bridgedRoomsByMatrixId[event.room_id];
        if (bridgedRoom) {
          bridgedRoom.onMatrixMessage(event);
          handled = true;
        }

        if (!handled) {
          console.log("  Wasn't expecting this room; ignore");
        }
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
        var bridgedRoom = new BridgedRoom(bridge, config,
            new MatrixRoom(roomConfig.matrix_room_id), new GitterRoom(roomName), room
        );

        bridgedRoomsByMatrixId[bridgedRoom.matrixRoomId()] = bridgedRoom;

        var events = room.streaming().chatMessages();

        events.on('chatMessages', function(message) {
          if (message.operation !== 'create' ||
              !message.model.fromUser) {
            return;
          }

          if(message.model.fromUser.id == gitterUserId) {
            // Ignore a reflection of my own messages
            return;
          }

          bridgedRoom.onGitterMessage(message);
        });
      });
    }

    config.rooms.forEach(onNewGitterRoom);
  });

  function onBotInvited(room_id) {
    bridge.getIntent().join(room_id);
  }

  function onBotJoined(room_id) {
  }

  function onBotLeft(room_id) {
  }

  function onMatrixAdminMessage(event) {
    var cmd = event.content.body;
    console.log("Admin: " + cmd);

    function respond(message) {
      bridge.getIntent().sendText(event.room_id,
          event.user_id + ": " + message
      );
    }

    var args = cmd.match(/(?:[^\s"]+|"[^"]*")+/g);
    cmd = args.shift();

    // TODO(paul): Turn this into a nicer introspective lookup on methods or something
    if (cmd == "link") {
      var matrixId = args.shift();
      var gitterName = args.shift();

      var store = bridge.getRoomStore();

      Promise.all([
        store.getRemoteLinks(matrixId),
        store.getMatrixLinks(gitterName)
      ]).then(function (result) {
        var remoteLinks = result[0];
        var matrixLinks = result[1];

        if (remoteLinks.length) {
          return respond("Cannot link - matrix-id " + matrixId + " is already linked to " + remoteLinks[0].remote);
        }
        else if (matrixLinks.length) {
          return respond("Cannot link - gitter-name " + gitterName + " is already linked to " + matrixLinks[0].matrix);
        }

        var matrixRoom = new MatrixRoom(matrixId);
        var gitterRoom = new GitterRoom(gitterName);

        return store.linkRooms(matrixRoom, gitterRoom, {}, matrixId+" "+gitterName).then(function () {
          respond("Linked");
          // TODO: start the room bridging
        });
      });
    }
    else if (cmd == "unlink") {
      var id = args.shift();
      var linkPromise;

      var store = bridge.getRoomStore();

      if (id.match(/^!/)) {
        linkPromise = store.getRemoteLinks(id);
      }
      else {
        linkPromise = store.getMatrixLinks(id);
      }

      linkPromise.then(function (links) {
        if (!links.length) {
          return respond("Cannot unlink - not known");
        }

        var link = links[0];
        return store.unlinkRoomIds(link.matrix, link.remote).then(function () {
          respond("Unlinked");
          // TODO: stop the room bridging
        });
      })
    }
    else {
      respond("Unrecognised command: " + cmd);
    }
  }

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
