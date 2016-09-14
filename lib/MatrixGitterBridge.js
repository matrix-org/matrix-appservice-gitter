"use strict";

var Promise = require("bluebird");

var Gitter = require('node-gitter');
var GitterRealtimeClient = require('gitter-realtime-client');

var GitterUser = require("./GitterUser");

var RemoteUser = require("matrix-appservice-bridge").RemoteUser;
var Bridge = require("matrix-appservice-bridge").Bridge;

var BridgedRoom = require("./BridgedRoom");

var AdminCommands = require("./AdminCommands");
var Provisioning = require("./Provisioning");

var MatrixIdTemplate = require("./MatrixIdTemplate");

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

            onAliasQuery: this.onAliasQuery.bind(this),

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
            },

            thirdPartyLookup: {
                protocols: ["gitter"],
                getProtocol: this.getThirdPartyProtocol.bind(this),
                getLocation: this.getThirdPartyLocation.bind(this),
                getUser: this.getThirdPartyUser.bind(this),
            },
        }
    });

    this._bridge = bridge;
    this._gitterUserId = null;

    // map gitter user ID strings to Promise<RemoteUser>
    this._gitterUserPromisesById = {};

    this.username_template = new MatrixIdTemplate(
        "@", config.username_template, config.matrix_user_domain
    );
    if (!this.username_template.hasField("USER")) {
        throw new Error("Expected the 'username_template' to contain the string ${USER}");
    }

    this.alias_template = null;

    if (config.enable_portals) {
        this.alias_template = new MatrixIdTemplate(
            "#", config.alias_template, config.matrix_user_domain
        );
        if (!this.alias_template.hasField("ROOM")) {
            throw new Error("Expected the 'alias_template' to contain the string ${ROOM}");
        }
    }

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
    return this.username_template.expandLocalpart({USER: username});
};

// Returns a string for an entire Matrix User ID to represent a given gitter
//   username
MatrixGitterBridge.prototype.mxidFromGitterName = function(username) {
    return this.username_template.expandId({USER: username});
};

// Returns a string for a gitter username when given a Matrix User ID for a
//   user hosted on this AS, or returns null if the user ID is not recognised.
//   Inverse of mxidFromGitterName().
MatrixGitterBridge.prototype.gitterNameFromMxid = function(mxid) {
    var fields = this.username_template.matchId(mxid);
    return fields ? fields.USER : null;
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
MatrixGitterBridge.prototype.getOrCreateBridgedRoom = function(gitterName) {
    if (gitterName in this._bridgedRoomsByGitterRoomname) {
        return Promise.resolve(this._bridgedRoomsByGitterRoomname[gitterName]);
    }

    var bridgedRoom = new BridgedRoom({
        bridge: this,
        gitter: this._gitter,
        gitterRealtime: this._gitterRealtime,

        gitterRoomName: gitterName,
    });

    this._bridgedRoomsByGitterRoomname[gitterName] = bridgedRoom;

    return bridgedRoom.joinAndStart()
        .then(() => bridgedRoom);
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

    // Ignore "# comment" lines as chatter between humans sharing the console
    if (cmd.match(/^\s*#/)) return;

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
        try {
            c.run(this, args, respond);
        }
        catch (e) {
            respond("Command failed: " + e);
        }
    }
    else {
        respond("Unrecognised command: " + cmd);
    }
};

MatrixGitterBridge.prototype.getThirdPartyProtocol = function(protocol) {
    return Promise.resolve({
        user_fields: ["username"],
        location_fields: ["room"],
        instances: [
            {
                desc: "Gitter",
                fields: {},
            },
        ],
    });
};

function isValidGitterId(id) {
    if (id.match(/^-|--|[^0-9a-z-]|-$/)) {
        return false;
    }
    return true;
}

MatrixGitterBridge.prototype.getThirdPartyLocation = function(protocol, fields) {
    var roomname;
    var alias;

    if ("room" in fields) {
        // Forward room->alias lookup

        // gitter room name should contain at most one '/'
        var parts = fields.room.split(/\//);
        if (parts.length > 2) {
            return Promise.reject({code: 400, err: "Invalid room name"});
        }

        parts = parts.map((s) => s.toLowerCase());

        // Each name component individually should be a valid gitter ID
        if(!isValidGitterId(parts[0]) ||
                (parts.length > 1 && !isValidGitterId(parts[1]))) {
            return Promise.reject({code: 400, err: "Invalid room name"});
        }

        roomname = parts.join("/");
        alias = this.alias_template.expandId({
            ROOM: roomname.replace(/\//, "=2F"),
        });
    }
    else {
        return Promise.reject({code: 400, err: "Require a 'room' parameter'"});
    }

    return Promise.resolve({
        alias: alias,
        protocol: "gitter",
        fields: { room: roomname },
    });
};

MatrixGitterBridge.prototype.getThirdPartyUser = function(protocol, fields) {
    var username;
    var userid;

    if ("username" in fields) {
        // Forward name->MXID lookup

        // Strip a leading @ if one exists and fold to lower case
        username = fields.username.replace(/^@/, "").toLowerCase();

        userid = this.mxidFromGitterName(username);
    }
    // TODO(paul): reverse MXID->gitter lookup
    else {
        return Promise.reject({code: 400, err: "Require a 'username' parameter'"});
    }

    // Github (and hence Gitter) usernames must contain only alphanumerics and
    //   hyphens, may not start or end with a hyphen, and may not contain a
    //   double-hyphen
    if (!isValidGitterId(username)) {
        return Promise.reject({code: 400, err: "Invalid username"});
    }

    return Promise.resolve({
        userid: userid,
        protocol: "gitter",
        fields: { username: username },
    });
};

MatrixGitterBridge.prototype.onAliasQuery = function(alias, localpart) {
    if (!this.alias_template) return null;

    var result = this.alias_template.matchId(alias);
    if (!result) return null;

    // unescape the =2F encoding of '/'
    var gitterName = result.ROOM.replace(/=2F/i, "/");

    return this.actionMakePortal(gitterName).then((result) => {
        return result.matrix_room_id;
    });
};

MatrixGitterBridge.prototype.makeMatrixRoom = function(opts) {
    return this.getBotIntent().createRoom({
        options: {
            room_alias_name: opts.alias_localpart,
            name: opts.name,
            visibility: "public",
        },
    }).then((result) => {
        return result.room_id;
    });
};

MatrixGitterBridge.prototype.run = function(port) {
    var bridge = this._bridge;

    bridge.loadDatabases().then(() => {
        return this.getRoomStore().select({
            matrix_id: {$exists: true},
            remote_id: {$exists: true}
        });
    }).then((entries) => {
        entries.forEach((entry) => {
            var matrix_id = entry.matrix_id;
            var remote_id = entry.remote_id;
            var data = entry.data || {};

            return this.getOrCreateBridgedRoom(remote_id).then((room) => {
                if (data.portal) {
                    room.setPortalMatrixRoomId(matrix_id);
                }
                else {
                    room.linkMatrixRoom(matrix_id);
                }
                this._bridgedRoomsByMatrixId[matrix_id] = room;
            }).then(() => {
                console.log((data.portal ? "PORTAL " : "LINKED ") +
                            matrix_id + " to " + remote_id);
            }).catch((e) => {
                console.log("Failed to link " + matrix_id + " to " + remote_id, e);
            });
        });
    });

    bridge.run(port, this._config);

    var app = bridge.addAppServicePath({
        method: "POST",
        path: "/_matrix/provision/:verb",
        handler: (req, res) => {
            console.log("Received a _matrix/provision request for " + req.params.verb);

            var prov = Provisioning[req.params.verb];
            if (prov) {
                prov.run(this, req, res);
            }
            else {
                res.status(404).json({error: "Unrecognised admin command"});
            }
        }
    })
};

// Methods below here are the "actions", the actual backing code behind
//   commands that can be typed in the admin console.

MatrixGitterBridge.prototype.actionLink = function(matrixId, gitterName) {
    var store = this.getRoomStore();

    return store.getEntriesByMatrixId(matrixId).then((remoteLinks) => {
        if (remoteLinks.length) {
            return Promise.reject("matrix-id " + matrixId + " is already linked to " + remoteLinks[0].remote);
        }

        var linkId = matrixId + " " + gitterName;

        return store.insert({
            id: linkId,
            matrix_id: matrixId,
            remote_id: gitterName,
        }).then(() => {
            return this.getOrCreateBridgedRoom(gitterName);
        }).then((room) => {
            room.linkMatrixRoom(matrixId);
            this._bridgedRoomsByMatrixId[matrixId] = room;
        }).then(() => {
            console.log("LINKED " + matrixId + " to " + gitterName);
        });
    });
};

MatrixGitterBridge.prototype.actionUnlink = function(matrixId, gitterName) {
    var store = this.getRoomStore();

    var linkId = matrixId + " " + gitterName;

    return store.delete({id: linkId}).then(() => {
        var bridgedRoom = this._bridgedRoomsByMatrixId[matrixId];
        if (bridgedRoom) {
            delete this._bridgedRoomsByMatrixId[matrixId];
            return bridgedRoom.unlinkMatrixRoom(matrixId);
        }
    }).then(() => {
        console.log("UNLINKED " + matrixId + " to " + gitterName);
    });
};

MatrixGitterBridge.prototype.actionMakePortal = function(gitterName) {
    var store = this.getRoomStore();

    // TODO(paul): MatrixIdTemplate ought to take care of this
    var gitterNameEscaped = gitterName.replace(/\//g, "=2F");

    // TODO(paul): this is currently rather racy if multiple calls are in
    // flight at the same time.

    return this.getOrCreateBridgedRoom(gitterName).then((room) => {
        var room_id = room.getPortalMatrixRoomId();

        return room_id ? Promise.resolve(room_id) : this.makeMatrixRoom({
            alias_localpart: this.alias_template.expandLocalpart({
                ROOM: gitterNameEscaped
            }),
            name: gitterName,
        }).then((matrixId) => {
            var linkId = matrixId + " " + gitterName;

            return store.insert({
                id: linkId,
                matrix_id: matrixId,
                remote_id: gitterName,
                data: {portal: true},
            }).then(() => {
                room.setPortalMatrixRoomId(matrixId);
                this._bridgedRoomsByMatrixId[matrixId] = room;
                return matrixId;
            });
        });
    }).then((matrixId) => {
        return {
            matrix_alias: this.alias_template.expandId({
                ROOM: gitterNameEscaped,
            }),
            matrix_room_id: matrixId,
        };
    });
};

module.exports = MatrixGitterBridge;
