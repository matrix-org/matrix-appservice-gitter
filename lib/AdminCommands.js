"use strict";

var Promise = require("bluebird");

var AdminCommand = require("./AdminCommand");

var RateLimiter = require("./RateLimiter");

var adminCommands = {};

// Some helper functions
function resolveRoomEntries(main, id) {
    var store = main.getRoomStore();

    if (id.match(/^!/)) {
        return store.select({matrix_id: id});
    }
    else {
        return store.select({remote_id: id});
    }
}

function resolveRoomEntry(main, id) {
    return resolveRoomEntries(main, id).then((entries) => {
        if (!entries.length || !entries[0] || !entries[0].matrix_id || !entries[0].remote_id) {
            return Promise.reject("not known");
        }
        return entries[0];
    });
}

adminCommands.help = AdminCommand.makeHelpCommand(adminCommands);

adminCommands.list = new AdminCommand({
    desc: "list the linked rooms",
    func: function(main, args, respond) {
        Object.keys(main._bridgedRoomsByGitterRoomname).sort().forEach((gitterName) => {
            var room = main._bridgedRoomsByGitterRoomname[gitterName];

            var matrix_room_ids = room.getLinkedMatrixRoomIds();
            var portal_room_id = room.getPortalMatrixRoomId();

            var status = room.status();

            if(matrix_room_ids.length == 1) {
                respond("Linked (" + status + ") " + gitterName + " " + matrix_room_ids[0]);
            }
            else if(matrix_room_ids.length > 1) {
                respond("Multi-linked (" + status + ") " + gitterName + ":");
                matrix_room_ids.forEach((id) => respond(" " + id));
            }

            if (portal_room_id) {
                respond("Portal (" + status + ") " + gitterName + " " + portal_room_id);
            }

            if (!matrix_room_ids.length && !portal_room_id) {
                respond("Unlinked (" + status + ") " + gitterName);
            }
        });
    },
});

adminCommands.link = new AdminCommand({
    desc: "connect a Matrix and a Gitter room together",
    func: function(main, args, respond) {
        var matrixId = args.shift();
        var gitterName = args.shift();

        return main.actionLink(matrixId, gitterName).then(
            ()    => { respond("Linked"); },
            (err) => { respond("Cannot link - " + err); }
        );
    },
});

adminCommands.unlink = new AdminCommand({
    desc: "disconnect a Matrix and a Gitter room",
    func: function(main, args, respond) {
        // The user only types a single "id" here, being either a matrix room ID
        //   or a gitter room name. We can detect which by its syntactic form,
        //   then look up the corresponding other side of the link, to request
        //   removal of.
        var id = args.shift();
        var linkPromise;

        var store = main.getRoomStore();

        if (id.match(/^!/)) {
            linkPromise = store.getEntriesByMatrixId(id);
        }
        else {
            linkPromise = store.getEntriesByRemoteId(id);
        }

        return linkPromise.then((entries) => {
            if (!entries.length || !entries[0] || !entries[0].matrix || !entries[0].remote) {
                return Promise.reject("not known");
            }

            var entry = entries[0];
            return main.actionUnlink(entry.matrix.getId(), entry.remote.getId());
        }).then(
            ()    => { respond("Unlinked"); },
            (err) => { respond("Cannot unlink - " + err); }
        );
    },
});

adminCommands.mkportal = new AdminCommand({
    desc: "create a new Matrix room as a portal to a Gitter room",
    func: function(main, args, respond) {
        var gitterName = args.shift();

        return main.actionMakePortal(gitterName).then(
            (res) => { respond("Portal room is " + res.matrix_alias +
                               " (" + res.matrix_room_id + ")"); },
            (err) => { respond("Cannot make portal - " + err); }
        );
    },
});

adminCommands.leave = new AdminCommand({
    desc: "leave a (stale) matrix room",
    func: function(main, args, respond) {
        var matrixId = args.shift();

        if (main.getBridgedRoomByMatrixId(matrixId)) {
            return Promise.reject("Cannot leave; this room is linked");
        }

        // TODO: consider some sort of warning about the count of ghost users
        //   to be removed if it's large...
        return main.listGhostUsers(matrixId).then((user_ids) => {
            respond("Draining " + user_ids.length + " ghosts from " + matrixId);

            return Promise.each(user_ids, (user_id) => {
                return main.getBridge().getIntent(user_id).leave(matrixId);
            });
        }).then(() => {
            return main.getBotIntent().leave(matrixId);
        }).then(() => {
            respond("Drained and left " + matrixId);
        });
    },
});

adminCommands.count_legacy = new AdminCommand({
    desc: "count the number of legacy-named users",
    func: function(main, args, respond) {
        var store = main._bridge.getUserStore();

        return store.select({
            "data.mxid_localpart": {$exists: false},
        }).then((entries) => {
            respond("Found " + entries.length + " user entries lacking mxid_localpart");
        });
    },
});

adminCommands.set_access_token = new AdminCommand({
    desc: "set an OAuth2 access_token for matrix->gitter account puppeting",
    func: function(main, args, respond) {
        var user_id = args.shift();
        var access_token = args.shift();

        return main._bridge.getUserStore().upsert(
            {type: "matrix", id: user_id},
            {type: "matrix", id: user_id, data: {gitter_access_token: access_token}}
        ).then(() => {
            // Remove the cached ghost so it gets recreated
            delete main._gitterGhostsByMatrixId[user_id];

            respond("Updated");
        });
    },
});

adminCommands.sync_users = new AdminCommand({
    desc: "synchronise users between Matrix and Gitter",
    opts: {
        'count|c': "only count",
        'join|j': "include joins",
        'leave|l': "include leaves",
        'all|A': "all rooms",
    },
    func: function(main, opts, args, respond) {
        var id = args.shift();

        if (!opts.join && !opts.leave) {
            opts.join = true;
            opts.leave = true;
        }

        function syncOneEntry(entry) {
            var room = main.getBridgedRoomByGitterName(entry.remote_id);
            return room.syncUsers({
                join: opts.join,
                leave: opts.leave,
                countOnly: opts.count,
                rateLimiter: new RateLimiter(2 * 1000),
            });
        }

        var p;
        if (opts.all) {
            var counts = {join: 0, leave: 0};

            p = main.getRoomStore().select({remote_id: {$exists: true}}).then((entries) => {
                var nrooms = entries.length;

                return Promise.each(entries, (entry, idx) => {
                    return syncOneEntry(entry).then((c) => {
                        counts.join  += c.join;
                        counts.leave += c.leave;
                        respond("Join " + c.join + " and leave " + c.leave + " in " +
                                entry.remote_id + " [" + (idx+1) + "/" + nrooms + "]");
                    }).catch((e) => {
                        respond("Failed " + entry.remote_id + ": " + e);
                    });
                });
            }).then(() => counts);
        }
        else {
            p = resolveRoomEntry(main, id)
                .then((entry) => syncOneEntry(entry));
        }

        return p.then((counts) => {
            respond("Join " + counts.join + " and leave " + counts.leave + " users total");
        });
    },
});

module.exports = adminCommands;
