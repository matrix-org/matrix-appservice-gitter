"use strict";

var Promise = require("bluebird");

var MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;
var GitterRoom = require("matrix-appservice-bridge").RemoteRoom;

function AdminCommand(opts) {
    this._desc = opts.desc;
    this._func = opts.func;
}

AdminCommand.prototype.run = function(bridge, args, respond) {
    // TODO(paul): some introspection about required arguments, etc...
    this._func(bridge, args, respond);
}

var adminCommands = {};

adminCommands.help = new AdminCommand({
    desc: "display a list of commands",
    func: function(bridge, args, respond) {
        // TODO(paul): more detailed help on a single command
        Object.keys(adminCommands).sort().forEach(function (k) {
            var cmd = adminCommands[k];
            respond(k + ": " + cmd._desc);
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
            linkPromise = store.getRemoteLinks(id);
        }
        else {
            linkPromise = store.getMatrixLinks(id);
        }

        linkPromise.then((links) => {
            if (!links.length || !links[0] || !links[0].matrix || !links[0].remote) {
                return Promise.reject("not known");
            }

            var link = links[0];
            return bridge.actionUnlink(link.matrix, link.remote);
        }).then(
            ()    => { respond("Unlinked"); },
            (err) => { respond("Cannot unlink - " + err); }
        );
    },
});

module.exports = adminCommands;
