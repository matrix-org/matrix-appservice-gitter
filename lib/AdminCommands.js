"use strict";

var Promise = require("bluebird");

var AdminCommand = require("./AdminCommand");

var adminCommands = {};

adminCommands.help = AdminCommand.makeHelpCommand(adminCommands);

adminCommands.list = new AdminCommand({
    desc: "list the linked rooms",
    func: function(bridge, args, respond) {
        Object.keys(bridge._bridgedRoomsByGitterRoomname).sort().forEach((gitterName) => {
            var room = bridge._bridgedRoomsByGitterRoomname[gitterName];
            var matrix_room_ids = room.getMatrixRoomIds();
            if (!matrix_room_ids.length) {
                respond("BridgedRoom " + gitterName + " unlinked");
            }
            else if(matrix_room_ids.length == 1) {
                respond("BridgedRoom " + gitterName + " " + matrix_room_ids[0]);
            }
            else {
                respond("BridgedRoom " + gitterName + " linked:");
                matrix_room_ids.forEach((id) => respond(" " + id));
            }
        });
    },
});

adminCommands.link = new AdminCommand({
    desc: "connect a Matrix and a Gitter room together",
    func: function(bridge, args, respond) {
        var matrixId = args.shift();
        var gitterName = args.shift();

        bridge.actionLink(matrixId, gitterName).then(
            ()    => { respond("Linked"); },
            (err) => { respond("Cannot link - " + err); }
        );
    },
});

adminCommands.unlink = new AdminCommand({
    desc: "disconnect a Matrix and a Gitter room",
    func: function(bridge, args, respond) {
        // The user only types a single "id" here, being either a matrix room ID
        //   or a gitter room name. We can detect which by its syntactic form,
        //   then look up the corresponding other side of the link, to request
        //   removal of.
        var id = args.shift();
        var linkPromise;

        var store = bridge.getRoomStore();

        if (id.match(/^!/)) {
            linkPromise = store.getEntriesByMatrixId(id);
        }
        else {
            linkPromise = store.getEntriesByRemoteId(id);
        }

        linkPromise.then((entries) => {
            console.log("Entries:", entries);

            if (!entries.length || !entries[0] || !entries[0].matrix || !entries[0].remote) {
                return Promise.reject("not known");
            }

            var entry = entries[0];
            return bridge.actionUnlink(entry.matrix.getId(), entry.remote.getId());
        }).then(
            ()    => { respond("Unlinked"); },
            (err) => { respond("Cannot unlink - " + err); }
        );
    },
});

module.exports = adminCommands;
