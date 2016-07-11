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

adminCommands.link = new AdminCommand({
    desc: "connect a Matrix and a Gitter room together",
    func: function(bridge, args, respond) {
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
                return bridge.createAndStartBridgedRoom(matrixRoom, gitterRoom);
            }).then(() => {
                console.log("LINKED " + matrixRoom.getId() + " to " + gitterRoom.getId());
                respond("Linked");
            });
        });
    },
});

adminCommands.unlink = new AdminCommand({
    desc: "disconnect a Matrix and a Gitter room",
    func: function(bridge, args, respond) {
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
                return respond("Cannot unlink - not known");
            }

            var link = links[0];

            var matrixId = link.matrix;
            var gitterId = link.remote;

            return store.unlinkRoomIds(link.matrix, link.remote).then(() => {
                var bridgedRoom = bridge._bridgedRoomsByMatrixId[matrixId];
                if (bridgedRoom) {
                    delete bridge._bridgedRoomsByMatrixId[matrixId];
                    return bridgedRoom.stopAndLeave();
                }
            }).then(() => {
                console.log("UNLINKED " + matrixId + " to " + gitterId);
                respond("Unlinked");
            });
        })
    },
});

module.exports = adminCommands;
