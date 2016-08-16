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

var AdminCommands = require("./AdminCommands");
var Provisioning = require("./Provisioning");

function MatrixGitterBridge(config) {
    var self = this;

    this._bridgedRoomsByGitterRoomname = {};
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

                console.log('matrix->' + event.room_id + ' from ' + event.user_id + ':', event.content.body);

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

    // map gitter user ID strings to Promise<RemoteUser>
    this._gitterUserPromisesById = {};

    var matchinfo = config.username_template.match(/^(.*)\${USER}(.*)$/);
    if (!matchinfo) {
        throw new Error("Expected the 'username_template' to contain the string ${USER}");
    }

    this._userDomain = config.matrix_user_domain;
    this._localpartTemplate = [matchinfo[1], matchinfo[2]];
    this._useridPattern = new RegExp(
        "^@" + config.username_template.replace(/\${USER}/, "(.*?)")
             + ":"
             + config.matrix_user_domain + "$");

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

// Returns a string for a Matrix User ID localpart to represent a given gitter
//   username
MatrixGitterBridge.prototype.localpartFromGitterName = function(username) {
    return this._localpartTemplate[0] + username.toLowerCase() + this._localpartTemplate[1];
};

// Returns a string for an entire Matrix User ID to represent a given gitter
//   username
MatrixGitterBridge.prototype.mxidFromGitterName = function(username) {
    return '@' + this.localpartFromGitterName(username) + ':' + this._userDomain;
};

// Returns a string for a gitter username when given a Matrix User ID for a
//   user hosted on this AS, or returns null if the user ID is not recognised.
//   Inverse of mxidFromGitterName().
MatrixGitterBridge.prototype.gitterNameFromMxid = function(mxid) {
    console.log("Wonder if " + mxid + " is matched by", this._useridPattern);
    var info = this._useridPattern.exec(mxid);
    if (info) {
        return info[1];
    }
    else {
        return null;
    }
};

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

// Obtain a RemoteUser instance from a Gitter user object, creating and adding
//   it to the database if one didn't previously exist
MatrixGitterBridge.prototype.mapGitterUser = function(user) {
    var id = user.id;

    return this._gitterUserPromisesById[id] = (this._gitterUserPromisesById[id] ||
        this.getRemoteUser(id).then((model) => {
            if(!model) {
                model = new RemoteUser(id, {username: user.username});
            }

            return new GitterUser(this, model);
        })
    );
};

// Obtain a RemoteUser instance from a Gitter user ID string if one had
//   previously been created (see mapGitterUser), or null if one does not
//   already exist.
MatrixGitterBridge.prototype.getGitterUserById = function(id) {
    var p = this._gitterUserPromisesById[id];
    if (p) return p;

    return this.getRemoteUser(id).then((model) => {
        if (!model) {
            return Promise.resolve(null);
        }

        p = Promise.resolve(new GitterUser(this, model));
        this._gitterUserPromisesById[id] = p;
        return p;
    });
};

MatrixGitterBridge.prototype.getIntentFromLocalpart = function(localpart) {
    return this._bridge.getIntentFromLocalpart(localpart);
};

MatrixGitterBridge.prototype.getBotIntent = function() {
    return this._bridge.getIntent();
};

MatrixGitterBridge.prototype.getRemoteUser = function(id) {
    return this._bridge.getUserStore().getRemoteUser(id);
};

MatrixGitterBridge.prototype.putRemoteUser = function(user) {
    return this._bridge.getUserStore().setRemoteUser(user);
};

MatrixGitterBridge.prototype.getRoomStore = function() {
    return this._bridge.getRoomStore();
}

// Returns a Promise of a BridgedRoom instance
MatrixGitterBridge.prototype.getOrCreateBridgedRoom = function(gitterRoom) {
    var gitterId = gitterRoom.getId();

    if (gitterId in this._bridgedRoomsByGitterRoomname) {
        return Promise.resolve(this._bridgedRoomsByGitterRoomname[gitterId]);
    }

    var bridgedRoom = new BridgedRoom({
        bridge: this,
        gitter: this._gitter,
        gitterRealtime: this._gitterRealtime,

        gitterRoomModel: gitterRoom
    });

    this._bridgedRoomsByGitterRoomname[gitterId] = bridgedRoom;

    return bridgedRoom.joinAndStart()
        .then(() => bridgedRoom);
};

MatrixGitterBridge.prototype.linkGitterToMatrix = function(gitterRoom, matrixRoom) {
    return this.getOrCreateBridgedRoom(gitterRoom).then((bridgedRoom) => {
        bridgedRoom.linkMatrixRoom(matrixRoom);
        this._bridgedRoomsByMatrixId[matrixRoom.getId()] = bridgedRoom;
        return bridgedRoom;
    });
};

MatrixGitterBridge.prototype.onBotInvited = function(room_id) {
    this.getBotIntent().join(room_id);
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

    var c = AdminCommands[cmd];
    if (c) {
        c.run(this, args, respond);
    }
    else {
        respond("Unrecognised command: " + cmd);
    }
};

MatrixGitterBridge.prototype.onUserMappingQuery = function(req, res) {
    var query = req.query || {};

    var userid;
    var fields;

    if ("username" in query) {
        // Forward name->MXID lookup
        fields = { username: query.username };
        userid = this.mxidFromGitterName(query.username);
    }
    // TODO(paul): reverse MXID->gitter lookup
    else {
        res.status(400).json({error: "Require a 'username' parameter"});
        return;
    }

    res.status(200).json({
        userid: userid,
        protocol: "gitter",
        fields: fields,
    });
};

MatrixGitterBridge.prototype.run = function(port) {
    var bridge = this._bridge;

    bridge.loadDatabases().then(() => {
        return this.getRoomStore().getLinksByData({});
    }).then((links) => {
        links.forEach((link) => {
            return this.linkGitterToMatrix(
                new GitterRoom(link.remote), new MatrixRoom(link.matrix)
            ).then(() => {
                console.log("LINKED " + link.matrix + " to " + link.remote);
            }).catch((e) => {
                console.log("Failed to link " + link.matrix + " to " + link.remote, e);
            });
        });
    });

    bridge.run(port, this._config);

    // TODO(paul): lots of gut-wrenching into other libraries here
    var app = bridge.appService.app;
    app.post("/_matrix/provision/:verb", (req, res) => {
        console.log("Received a _matrix/provision request for " + req.params.verb);

        var prov = Provisioning[req.params.verb];
        if (prov) {
            prov.run(this, req, res);
        }
        else {
            res.status(404).json({error: "Unrecognised admin command"});
        }
    });

    // TODO(paul): This doesn't capture the reverse MXID->3PU lookup API
    app.get("/_matrix/app/:ver/3pu/:protocol", (req, res) => {
        if (req.params.ver != "unstable") {
            res.status(404).send("Cannot GET " + req.path + "\r\n");
            return;
        }
        if (req.params.protocol != "gitter") {
            res.status(404).send("Unknown 3PN protocol " + req.params.protocol + "\r\n");
            return;
        }

        this.onUserMappingQuery(req, res);
    });
};

// Methods below here are the "actions", the actual backing code behind
//   commands that can be typed in the admin console.

MatrixGitterBridge.prototype.actionLink = function(matrixId, gitterName) {
    var store = this.getRoomStore();

    return store.getRemoteLinks(matrixId).then((remoteLinks) => {
        if (remoteLinks.length) {
            return Promise.reject("matrix-id " + matrixId + " is already linked to " + remoteLinks[0].remote);
        }

        var matrixRoom = new MatrixRoom(matrixId);
        var gitterRoom = new GitterRoom(gitterName);

        return store.linkRooms(matrixRoom, gitterRoom, {}, matrixId+" "+gitterName).then(() => {
            return this.linkGitterToMatrix(gitterRoom, matrixRoom);
        }).then(() => {
            console.log("LINKED " + matrixRoom.getId() + " to " + gitterRoom.getId());
        });
    });
};

MatrixGitterBridge.prototype.actionUnlink = function(matrixId, gitterName) {
    var store = this.getRoomStore();

    return store.unlinkRoomIds(matrixId, gitterName).then(() => {
        var bridgedRoom = this._bridgedRoomsByMatrixId[matrixId];
        if (bridgedRoom) {
            delete this._bridgedRoomsByMatrixId[matrixId];
            return bridgedRoom.unlinkMatrixRoom(new MatrixRoom(matrixId));
        }
    }).then(() => {
        console.log("UNLINKED " + matrixId + " to " + gitterName);
    });
};

module.exports = MatrixGitterBridge;
