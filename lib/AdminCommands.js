"use strict";

var Promise = require("bluebird");

var MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;
var GitterRoom = require("matrix-appservice-bridge").RemoteRoom;

var AdminCommand = require("./AdminCommand");

var adminCommands = {};

adminCommands.help = new AdminCommand({
    desc: "display a list of commands",
    func: function(bridge, args, respond) {
        // TODO(paul): more detailed help on a single command
        Object.keys(adminCommands).sort().forEach(function (k) {
            var cmd = adminCommands[k];
            respond(k + ": " + cmd.desc);
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
