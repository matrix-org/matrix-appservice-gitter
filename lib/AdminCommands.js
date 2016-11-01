"use strict";

var Promise = require("bluebird");

var AdminCommand = require("./AdminCommand");

var adminCommands = {};

adminCommands.help = AdminCommand.makeHelpCommand(adminCommands);

adminCommands.list = new AdminCommand({
    desc: "list the linked rooms",
    func: function(main, args, respond) {
        Object.keys(main._bridgedRoomsByGitterRoomname).sort().forEach((gitterName) => {
            var room = main._bridgedRoomsByGitterRoomname[gitterName];

            var matrix_room_ids = room.getLinkedMatrixRoomIds();
            var portal_room_id = room.getPortalMatrixRoomId();

            if(matrix_room_ids.length == 1) {
                respond("Linked " + gitterName + " " + matrix_room_ids[0]);
            }
            else if(matrix_room_ids.length > 1) {
                respond("Multi-linked " + gitterName + ":");
                matrix_room_ids.forEach((id) => respond(" " + id));
            }

            if (portal_room_id) {
                respond("Portal " + gitterName + " " + portal_room_id);
            }

            if (!matrix_room_ids.length && !portal_room_id) {
                respond("Unlinked " + gitterName);
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

        main.actionMakePortal(gitterName).then(
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

module.exports = adminCommands;
