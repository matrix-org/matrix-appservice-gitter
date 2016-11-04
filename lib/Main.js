"use strict";

var Promise = require("bluebird");

var Gitter = require('node-gitter');
var GitterRealtimeClient = require('gitter-realtime-client');

var GitterUser = require("./GitterUser");
var MatrixUser = require("./MatrixUser"); // NB: this is not bridgeLib.MatrixUser !

var MatrixEvent = require("matrix-js-sdk").MatrixEvent;

var bridgeLib = require("matrix-appservice-bridge");
var Bridge = bridgeLib.Bridge;
var StateLookup = bridgeLib.StateLookup;
var Metrics = bridgeLib.PrometheusMetrics;

var BridgedRoom = require("./BridgedRoom");

var AdminCommands = require("./AdminCommands");
var Provisioning = require("./Provisioning");

var MatrixIdTemplate = require("./MatrixIdTemplate");

// TODO(paul): monkeypatch
StateLookup.prototype.untrackRoom = StateLookup.prototype.untrackRoom ||
    function(roomId) {
        delete this._dict[roomId];
    };

function Main(config) {
    var self = this;

    this._config = config;

    this.homeserver = config.matrix_homeserver;

    this._bridgedRoomsByGitterRoomname = {};
    this._bridgedRoomsByMatrixId = {};

    this._gitter = new Gitter(config.gitter_api_key);
    this._gitterRealtime = new GitterRealtimeClient.RealtimeClient({token: config.gitter_api_key});

    // TODO(paul): ugh. this.getBotIntent() doesn't work before .run time
    // So we can't create the StateLookup instance yet
    this._stateStorage = null;

    var bridge = new Bridge({
        homeserverUrl: config.matrix_homeserver,
        domain: config.matrix_user_domain,
        registration: "gitter-registration.yaml",
        controller: {
            onUserQuery: function(queriedUser) {
                return {}; // auto-provision users with no additonal data
            },

            onAliasQuery: this.onAliasQuery.bind(this),

            onEvent: (req, context) => {
                var event = req.getData();

                this._stateStorage.onEvent(event);

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

                var bridgedRoom = self.getBridgedRoomByMatrixId(event.room_id);
                if (bridgedRoom) {
                    bridgedRoom.onMatrixMessage(event);
                    handled = true;
                }

                if (handled) {
                    // Have the bot send a read receipt to acknowledge
                    // successful transfer into gitter
                    if (self._config.enable_read_receipts) {
                        return this.getBotIntent().client.sendReadReceipt(
                            new MatrixEvent(event)
                        );
                    }
                }
                else {
                    console.log("  Wasn't expecting this room; ignore");
                    this.incCounter("dropped_messages", {side: "matrix"});
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

    // map gitter user ID strings to GitterUser instances
    this._gitterUsersById = {};

    // map matrix user ID strings to MatrixUser instances
    this._matrixUsersById = {};

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

    if (config.enable_metrics) {
        this.initialiseMetrics();
    }
}

Main.prototype.initialiseMetrics = function() {
    var metrics = this._metrics = this._bridge.getPrometheusMetrics();

    metrics.addGauge({
        name: "configured_rooms",
        help: "current count of room configurations",
        refresh: (gauge) => {
            gauge.set({side: "remote"},
                Object.keys(this._bridgedRoomsByGitterRoomname).length);
            gauge.set({side: "matrix"},
                Object.keys(this._bridgedRoomsByMatrixId).length);
        }
    });

    metrics.addGauge({
        name: "rooms",
        help: "current count of rooms partitioned by activity age",
        refresh: (gauge) => {
            var now = Date.now() / 1000;

            var remote_counts = new Metrics.AgeCounters();
            var matrix_counts = new Metrics.AgeCounters();

            Object.keys(this._bridgedRoomsByGitterRoomname).forEach((key) => {
                var room = this._bridgedRoomsByGitterRoomname[key];
                remote_counts.bump(now - room.getGitterATime());

                var matrix_atimes = room.getMatrixATimes();
                Object.keys(matrix_atimes).forEach((room_id) => {
                    var atime = matrix_atimes[room_id];
                    matrix_counts.bump(now - atime);
                });
            });

            remote_counts.setGauge(gauge, {side: "remote"});
            matrix_counts.setGauge(gauge, {side: "matrix"});
        }
    });

    metrics.addGauge({
        name: "users",
        help: "current count of mapped users partitioned by activity age",
        refresh: (gauge) => {
            var now = Date.now() / 1000;

            function count(side, users) {
                var counts = new Metrics.AgeCounters();

                Object.keys(users).forEach((id) => {
                    counts.bump(now - users[id].getATime());
                });

                counts.setGauge(gauge, {side: side});
            }

            count("remote", this._gitterUsersById);
            count("matrix", this._matrixUsersById);
        }
    });

    metrics.addGauge({
        name: "ghosts",
        help: "current count of ghosted users",
        refresh: (gauge) => {
            gauge.set({side: "remote"}, 0);
            // TODO(paul): this is gut-wrenching into matrix-appservice-bridge
            // subtract 1 because of the bot intent
            gauge.set({side: "matrix"},
                Object.keys(this._bridge._intents).length - 1);
        }
    });

    metrics.addCounter({
        name: "received_messages",
        help: "count of received messages",
    });
    metrics.addCounter({
        name: "dropped_messages",
        help: "count of received messages that are subsequently dropped",
    });
    metrics.addCounter({
        name: "sent_messages",
        help: "count of sent messages",
    });
    metrics.addCounter({
        name: "remote_api_calls",
        help: "Count of the number of remote API calls made",
    });
};

Main.prototype.getBridge = function() {
    return this._bridge;
};

Main.prototype.incCounter = function(name, labels) {
    if (!this._metrics) return;
    this._metrics.incCounter(name, labels);
};

Main.prototype.incRemoteCallCounter = function(type) {
    if (!this._metrics) return;
    this._metrics.incCounter("remote_api_calls", {method: type});
};

// Returns an 'http' URL to the media repo on the homeserver for a given 'mxc'
//   URL.
Main.prototype.getUrlForMxc = function(mxc_url) {
    return this.homeserver + "/_matrix/media/v1/download/" +
        mxc_url.substring("mxc://".length);
};

// Returns a string for a Matrix User ID localpart to represent a given gitter
//   username
Main.prototype.localpartFromGitterName = function(username) {
    return this.username_template.expandLocalpart({USER: username});
};

// Returns a string for an entire Matrix User ID to represent a given gitter
//   username
Main.prototype.mxidFromGitterName = function(username) {
    return this.username_template.expandId({USER: username});
};

// Returns a string for a gitter username when given a Matrix User ID for a
//   user hosted on this AS, or returns null if the user ID is not recognised.
//   Inverse of mxidFromGitterName().
Main.prototype.gitterNameFromMxid = function(mxid) {
    var fields = this.username_template.matchId(mxid);
    return fields ? fields.USER : null;
};

Main.prototype.getMyGitterUserId = function() {
    if (this._gitterUserId) {
        return Promise.resolve(this._gitterUserId);
    }

    return this._gitter.currentUser().then((u) => {
        this._gitterUserId = u.id;
        return u.id;
    });
};

Main.prototype.mangleName = function(name, _default) {
    var rules = this._name_mangling_rules;

    for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        var matches = rule.pattern.exec(name);
        if (!matches) continue;

        // TODO: more groups?
        return rule.template.replace('$1', matches[1]);
    }

    return _default;
}

// Obtain a GitterUser instance from a Gitter user object, creating and adding
//   it to the database if one didn't previously exist if opts.create is true
Main.prototype.getGitterUser = function(id, opts) {
    if (!opts) opts = {};

    var u = this._gitterUsersById[id];
    if (u) return Promise.resolve(u);

    return this._bridge.getUserStore().select({id: id}).then((entries) => {
        // in case of multiple racing database lookups, go with the first
        // successful result to avoid multiple objects
        u = this._gitterUsersById[id];
        if (u) return Promise.resolve(u);

        if (entries.length) {
            u = this._gitterUsersById[id] = GitterUser.fromEntry(this, entries[0]);
            return u;
        }

        if (!opts.create) {
            return null;
        }

        u = this._gitterUsersById[id] = new GitterUser(this, {
            id: id,
            mxid_localpart: this.localpartFromGitterName(opts.username.toLowerCase()),
            username: opts.username,
        });
        return this.putRemoteUser(u).then(() => u);
    });
};

Main.prototype.getOrCreateMatrixUser = function(id) {
    // This is currently a synchronous method but maybe one day it won't be
    var u = this._matrixUsersById[id];
    if (u) return Promise.resolve(u);

    u = this._matrixUsersById[id] = new MatrixUser(this, {user_id: id});
    return Promise.resolve(u);
};

Main.prototype.getBotIntent = function() {
    return this._bridge.getIntent();
};

Main.prototype.putRemoteUser = function(user) {
    var entry = user.toEntry();
    return this._bridge.getUserStore().upsert({id: entry.id}, entry);
};

Main.prototype.getRoomStore = function() {
    return this._bridge.getRoomStore();
}

// Returns a Promise of a BridgedRoom instance
Main.prototype.getOrCreateBridgedRoom = function(gitterName) {
    if (gitterName in this._bridgedRoomsByGitterRoomname) {
        return Promise.resolve(this._bridgedRoomsByGitterRoomname[gitterName]);
    }

    var bridgedRoom = new BridgedRoom({
        main: this,
        gitter: this._gitter,
        gitterRealtime: this._gitterRealtime,

        gitterRoomName: gitterName,
    });

    this._bridgedRoomsByGitterRoomname[gitterName] = bridgedRoom;

    return bridgedRoom.joinAndStart().then(
        () => bridgedRoom,
        (err) => {
            delete this._bridgedRoomsByGitterRoomname[gitterName];
            throw err;
        }
    );
};

Main.prototype.getBridgedRoomByMatrixId = function(roomId) {
    return this._bridgedRoomsByMatrixId[roomId];
};

// synchronous direct return from stored state, or null
Main.prototype.getStoredEvent = function(roomId, eventType, stateKey) {
    return this._stateStorage.getState(roomId, eventType, stateKey);
};

// asynchronous lookup using the botIntent client if stored state doesn't have
// it
Main.prototype.getState = function(roomId, eventType) {
    //   TODO: handle state_key. Has different return shape in the two cases
    var cached_event = this.getStoredEvent(roomId, eventType);
    if (cached_event && cached_event.length) {
        // StateLookup returns entire state events. client.getStateEvent returns
        //   *just the content*
        return Promise.resolve(cached_event[0].content);
    }

    return this.getBotIntent().client.getStateEvent(roomId, eventType);
};

Main.prototype.listAllUsers = function(matrixId) {
    return this.getBotIntent().roomState(matrixId).then((events) => {
        // Filter for m.room.member with membership="join"
        events = events.filter(
            (ev) => ev.type === "m.room.member" && ev.membership === "join"
        );

        return events.map((ev) => ev.state_key);
    });
};

Main.prototype.listGhostUsers = function(matrixId) {
    return this.listAllUsers(matrixId).then((user_ids) => {
        return user_ids.filter((id) => this.gitterNameFromMxid(id));
    });
};

Main.prototype.drainAndLeaveMatrixRoom = function(matrixRoomId) {
    return this.listGhostUsers(matrixRoomId).then((user_ids) => {
        console.log("Draining " + user_ids.length + " ghosts from " + matrixRoomId);

        return Promise.each(user_ids, (user_id) => {
            return this._bridge.getIntent(user_id).leave(matrixRoomId);
        });
    }).then(() => {
        return this.getBotIntent().leave(matrixRoomId);
    });
};

Main.prototype.onBotInvited = function(room_id) {
    this.getBotIntent().join(room_id);
};

Main.prototype.onBotJoined = function(room_id) {
};

Main.prototype.onBotLeft = function(room_id) {
};

Main.prototype.onMatrixAdminMessage = function(event) {
    var bridge = this._bridge;

    var cmd = event.content.body;

    // Ignore "# comment" lines as chatter between humans sharing the console
    if (cmd.match(/^\s*#/)) return;

    console.log("Admin: " + cmd);

    var response = [];
    function respond(message) {
        response.push(message);
    }

    // Split the command string into optionally-quoted whitespace-separated
    //   tokens. The quoting preserves whitespace within quoted forms
    // TODO(paul): see if there's a "split like a shell does" function we can use
    //   here instead.
    var args = cmd.match(/(?:[^\s"]+|"[^"]*")+/g);
    cmd = args.shift();

    var p;
    var c = AdminCommands[cmd];
    if (c) {
        p = Promise.try(() => {
            return c.run(this, args, respond);
        }).catch((e) => {
            respond("Command failed: " + e);
        });
    }
    else {
        respond("Unrecognised command: " + cmd);
        p = Promise.resolve();
    }

    p.then(() => {
        if (!response.length) response.push("Done");

        var message = (response.length == 1)
            ? event.user_id + ": " + response[0]
            : event.user_id + ":\n" + response.map((s) => "  " + s).join("\n");

        bridge.getIntent().sendText(event.room_id, message);
    });
};

Main.prototype.getThirdPartyProtocol = function(protocol) {
    return Promise.resolve({
        user_fields: ["username"],
        location_fields: ["room"],
        icon: this._config.icon_uri,
        field_types: {
            username: {
                regexp: "[a-zA-Z0-9-]+",
                placeholder: "username",
            },
            room: {
                regexp: "[a-zA-Z0-9-]+(/[^\s]+)",
                placeholder: "my-org/chat",
            },
        },
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

function isValidGitterRoomname(room) {
    var parts = room.split(/\//);

    // The toplevel name component should be a valid gitter ID
    if(!isValidGitterId(parts[0])) return false;

    // Gitter seems to be quite flexible on what other path components can be
    // so lets not bother checking them here.

    return true;
}

Main.prototype.getThirdPartyLocation = function(protocol, fields) {
    var roomname;
    var alias;

    if ("room" in fields) {
        // Forward room->alias lookup

        roomname = fields.room.toLowerCase();
        if (!isValidGitterRoomname(roomname)) {
            return Promise.reject({code: 400, err: "Invalid room name"});
        }

        alias = this.alias_template.expandId({
            ROOM: roomname.replace(/\//, "=2F"),
        });
    }
    else {
        return Promise.reject({code: 400, err: "Require a 'room' parameter'"});
    }

    return Promise.resolve([{
        alias: alias,
        protocol: "gitter",
        fields: { room: roomname },
    }]);
};

Main.prototype.getThirdPartyUser = function(protocol, fields) {
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

    return Promise.resolve([{
        userid: userid,
        protocol: "gitter",
        fields: { username: username },
    }]);
};

Main.prototype.onAliasQuery = function(alias, localpart) {
    if (!this.alias_template) return null;

    var result = this.alias_template.matchId(alias);
    if (!result) return null;

    // unescape the =2F encoding of '/'
    var gitterName = result.ROOM.replace(/=2F/i, "/");

    return this.actionMakePortal(gitterName).then((result) => {
        return result.matrix_room_id;
    });
};

Main.prototype.makeMatrixRoom = function(opts) {
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

Main.prototype.run = function(port) {
    var bridge = this._bridge;

    // Stagger the startup delays per room
    var delayTime = 0;

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

            var secs = delayTime;
            delayTime += 1;

            return Promise.delay(secs * 1000).then(() => {
                return this.getOrCreateBridgedRoom(remote_id);
            }).then((room) => {
                if (data.portal) {
                    room.setPortalMatrixRoomId(matrix_id);
                }
                else {
                    room.linkMatrixRoom(matrix_id);
                }
                this._bridgedRoomsByMatrixId[matrix_id] = room;
                this._stateStorage.trackRoom(matrix_id);
            }).then(() => {
                console.log((data.portal ? "PORTAL " : "LINKED ") +
                            matrix_id + " to " + remote_id);
            }).catch((e) => {
                console.log("Failed to link " + matrix_id + " to " + remote_id, e);
            });
        });
    });

    bridge.run(port, this._config);
    Provisioning.addAppServicePath(bridge, this);

    // TODO(paul): see above; we had to defer this until now
    this._stateStorage = new StateLookup({
        eventTypes: ["m.room.member", "m.room.power_levels"],
        client: bridge.getIntent().client,
    });
};

function stripPrefix(str, prefix) {
    if (str.startsWith(prefix)) {
        return str.substring(prefix.length);
    }
    return str;
}

// Methods below here are the "actions", the actual backing code behind
//   commands that can be typed in the admin console.

Main.prototype.actionLink = function(matrixId, gitterName) {
    var store = this.getRoomStore();

    // Sometimes people type a full gitter.im link in the "room name" box. Lets
    // be nice to them
    gitterName = stripPrefix(gitterName, "https://gitter.im/");

    return store.getEntriesByMatrixId(matrixId).then((remoteLinks) => {
        if (remoteLinks.length) {
            return Promise.reject("matrix-id " + matrixId + " is already linked to " + remoteLinks[0].remote.remote_id);
        }

        return this.getOrCreateBridgedRoom(gitterName);
    }).then((room) => {
        var linkId = matrixId + " " + gitterName;

        return store.insert({
            id: linkId,
            matrix_id: matrixId,
            remote_id: gitterName,
        }).then(() => room);
    }).then((room) => {
        room.linkMatrixRoom(matrixId);
        this._bridgedRoomsByMatrixId[matrixId] = room;
        this._stateStorage.trackRoom(matrixId);

        console.log("LINKED " + matrixId + " to " + gitterName);
    });
};

Main.prototype.actionUnlink = function(matrixId, gitterName) {
    var store = this.getRoomStore();

    var linkId = matrixId + " " + gitterName;

    return store.delete({id: linkId}).then(() => {
        var bridgedRoom = this._bridgedRoomsByMatrixId[matrixId];
        if (bridgedRoom) {
            delete this._bridgedRoomsByMatrixId[matrixId];
            this._stateStorage.untrackRoom(matrixId);
            return bridgedRoom.unlinkMatrixRoom(matrixId);
        }
    }).then(() => {
        console.log("UNLINKED " + matrixId + " to " + gitterName);
    });
};

Main.prototype.actionMakePortal = function(gitterName) {
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

// Code below is the "provisioning"; the commands available over the
// Provisioning API

Main.prototype.checkLinkPermission = function(matrix_room_id, user_id) {
    // We decide to allow a user to link or unlink, if they have a powerlevel
    //   sufficient to affect the 'm.room.power_levels' state; i.e. the
    //   "operator" heuristic.
    return this.getState(matrix_room_id, "m.room.power_levels").then((levels) => {
        var user_level =
            (levels.users && user_id in levels.users) ? levels.users[user_id] :
                levels.users_default;

        var requires_level =
            (levels.events && "m.room.power_levels" in levels.events) ? levels.events["m.room.power_levels"] :
            ("state_default" in levels) ? levels.state_default :
                50;

        return user_level >= requires_level;
    });
};

Provisioning.commands.getbotid = new Provisioning.Command({
    params: [],
    func: function(main, req, res) {
        res.json({bot_user_id: main._bridge.getBot().getUserId()});
    }
});

Provisioning.commands.getlink = new Provisioning.Command({
    params: ["matrix_room_id"],
    func: function(main, req, res, matrixId) {
        var room = main.getBridgedRoomByMatrixId(matrixId);
        if (!room) {
            res.status(404).json({error: "Link not found"});
            return;
        }

        res.json({
            remote_room_name: room.gitterRoomName(),
            matrix_room_id: matrixId,
        });
    }
});

Provisioning.commands.link = new Provisioning.Command({
    params: ["matrix_room_id", "remote_room_name", "user_id"],
    func: function(main, req, res, matrixId, gitterName, userId) {
        return main.checkLinkPermission(matrixId, userId).then((allowed) => {
            if (!allowed) return Promise.reject({
                code: 403,
                text: userId + " is not allowed to provision links in " + matrixId,
            });

            return main.actionLink(matrixId, gitterName);
        }).then(
            () => { res.json({}) }
        );
    },
});

Provisioning.commands.unlink = new Provisioning.Command({
    params: ["matrix_room_id", "remote_room_name", "user_id"],
    func: function(main, req, res, matrixId, gitterName, userId) {
        return main.checkLinkPermission(matrixId, userId).then((allowed) => {
            if (!allowed) return Promise.reject({
                code: 403,
                text: userId + " is not allowed to provision links in " + matrixId,
            });

            return main.actionUnlink(matrixId, gitterName);
        }).then(
            () => { res.json({}) }
        );
    },
});

module.exports = Main;
