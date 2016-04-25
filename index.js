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

  bridge.loadDatabases().then(() => {
    return bridge.getRoomStore().getLinksByData({});
  }).then((links) => {
    links.forEach((link) => {
      var bridgedRoom = new BridgedRoom(bridge, config, gitter,
          new MatrixRoom(link.matrix), new GitterRoom(link.remote)
      );

      bridgedRoomsByMatrixId[bridgedRoom.matrixRoomId()] = bridgedRoom;

      bridgedRoom.joinAndStart().then(() => {
        console.log("LINKED " + bridgedRoom.matrixRoomId() + " to " + bridgedRoom.gitterRoomName());
      });
    });
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
      ]).then((result) => {
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

        return store.linkRooms(matrixRoom, gitterRoom, {}, matrixId+" "+gitterName).then(() => {
          var bridgedRoom = new BridgedRoom(bridge, config, gitter, matrixRoom, gitterRoom);
          bridgedRoomsByMatrixId[bridgedRoom.matrixRoomId()] = bridgedRoom;

          return bridgedRoom.joinAndStart();
        }).then(() => {
          console.log("LINKED " + matrixRoom.id + " to " + gitterRoom.id);
          respond("Linked");
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

      linkPromise.then((links) => {
        console.log("Found links", links);

        if (!links.length || !links[0] || !links[0].matrix || !links[0].remote) {
          return respond("Cannot unlink - not known");
        }

        var link = links[0];

        var matrixId = link.matrix;
        var gitterId = link.remote;

        return store.unlinkRoomIds(link.matrix, link.remote).then(() => {
          var bridgedRoom = bridgedRoomsByMatrixId[matrixId];
          if (bridgedRoom) {
            delete bridgedRoomsByMatrixId[matrixId];
            return bridgedRoom.stopAndLeave();
          }
        }).then(() => {
          console.log("UNLINKED " + matrixId + " to " + gitterId);
          respond("Unlinked");
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
