"use strict";

var Promise = require("bluebird");

var Gitter = require('node-gitter');
var GitterRealtimeClient = require('gitter-realtime-client');

var GitterUser = require("./GitterUser");

var RemoteUser = require("matrix-appservice-bridge").RemoteUser;
var Bridge = require("matrix-appservice-bridge").Bridge;

var MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;

// TODO: maybe we'll extend it later
var GitterRoom = require("matrix-appservice-bridge").RemoteRoom;

var BridgedRoom = require("./BridgedRoom");

function MatrixGitterBridge(config) {
  var self = this;

  this._bridgedRoomsByMatrixId = {};

  this._gitter = new Gitter(config.gitter_api_key);
  this._gitterRealtime = new GitterRealtimeClient.RealtimeClient({token: config.gitter_api_key});

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
            self.onBotInvited(event.room_id);
          }
          else if (membership == "join") {
            self.onBotJoined(event.room_id);
          }
          else if (membership == "leave") {
            // TODO: "leave" events might mean we left the room, or got kicked
            //   while still in invite state - i.e. invite was cancelled
            //   before we joined.
            self.onBotLeft(event.room_id);
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
          self.onMatrixAdminMessage(event);
          handled = true;
        }

        var bridgedRoom = self._bridgedRoomsByMatrixId[event.room_id];
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

  this._bridge = bridge;
  this._gitterUserId = null;

  this._gitterusers = {};

  var rules = [];
  if (config.name_mangling) {
    for (var i = 0; i < config.name_mangling.length; i++) {
      var rule = config.name_mangling[i];

      rules.push({
        pattern: new RegExp(rule.pattern),
        template: rule.template
      });
    }
  }
  this._name_mangling_rules = rules;
}

MatrixGitterBridge.prototype.getMyGitterUserId = function() {
  if (this._gitterUserId) {
    return Promise.resolve(this._gitterUserId);
  }

  return this._gitter.currentUser().then((u) => {
    this._gitterUserId = u.id;
    return u.id;
  });
};

MatrixGitterBridge.prototype.mangleName = function(name) {
  var rules = this._name_mangling_rules;

  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    var matches = rule.pattern.exec(name);
    if (!matches) continue;

    // TODO: more groups?
    return rule.template.replace('$1', matches[1]);
  }

  return name;
}

MatrixGitterBridge.prototype.mapGitterUser = function(user) {
  var id = user.id;

  return this._gitterusers[id] = (this._gitterusers[id] ||
      this.getRemoteUser(id).then((model) => {
        if(!model) {
          model = new RemoteUser(id, {username: user.username});
        }

        return new GitterUser(this, model);
      }));
};

MatrixGitterBridge.prototype.getGitterUserById = function(id) {
  var user = this._gitterusers[id];
  if (user) {
    return user;
  }

  return this.getRemoteUser(id).then((model) => {
    if (!model) {
      return Promise.resolve();
    }

    user = Promise.resolve(new GitterUser(this, model));
    this._gitterusers[id] = user;
    return user;
  });
};

MatrixGitterBridge.prototype.getIntentFromLocalpart = function(localpart) {
  return this._bridge.getIntentFromLocalpart(localpart);
};

MatrixGitterBridge.prototype.getRemoteUser = function(id) {
  return this._bridge.getUserStore().getRemoteUser(id);
};

MatrixGitterBridge.prototype.putRemoteUser = function(user) {
  return this._bridge.getUserStore().setRemoteUser(user);
};

MatrixGitterBridge.prototype.createAndStartBridgedRoom = function(matrixRoom, gitterRoom) {
  var bridgedRoom = new BridgedRoom({
    bridge: this,
    gitter: this._gitter,
    gitterRealtime: this._gitterRealtime,

    matrixRoomModel: matrixRoom,
    gitterRoomModel: gitterRoom
  });

  this._bridgedRoomsByMatrixId[bridgedRoom.matrixRoomId()] = bridgedRoom;

  return bridgedRoom.joinAndStart();
};

MatrixGitterBridge.prototype.onBotInvited = function(room_id) {
  this._bridge.getIntent().join(room_id);
};

MatrixGitterBridge.prototype.onBotJoined = function(room_id) {
};

MatrixGitterBridge.prototype.onBotLeft = function(room_id) {
};

MatrixGitterBridge.prototype.onMatrixAdminMessage = function(event) {
  var bridge = this._bridge;

  var cmd = event.content.body;
  console.log("Admin: " + cmd);

  function respond(message) {
    bridge.getIntent().sendText(event.room_id,
        event.user_id + ": " + message
    );
  }

  // Split the command string into optionally-quoted whitespace-separated
  //   tokens. The quoting preserves whitespace within quoted forms
  // TODO(paul): see if there's a "split like a shell does" function we can use
  //   here instead.
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
        return this.createAndStartBridgedRoom(matrixRoom, gitterRoom);
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
        var bridgedRoom = this._bridgedRoomsByMatrixId[matrixId];
        if (bridgedRoom) {
          delete this._bridgedRoomsByMatrixId[matrixId];
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
};

MatrixGitterBridge.prototype.run = function(port) {
  var bridge = this._bridge;

  bridge.loadDatabases().then(() => {
    return bridge.getRoomStore().getLinksByData({});
  }).then((links) => {
    links.forEach((link) => {
      return this.createAndStartBridgedRoom(
          new MatrixRoom(link.matrix), new GitterRoom(link.remote)
      ).then(() => {
        console.log("LINKED " + link.matrix + " to " + link.remote);
      });
    });
  });

  bridge.run(port, this._config);
};

module.exports = MatrixGitterBridge;
