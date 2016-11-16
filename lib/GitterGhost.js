"use strict";

function GitterGhost(opts) {
    this._gitter = opts.gitter;

    this._roomsByName = {};
}

GitterGhost.prototype._getRoom = function(roomName) {
    if (this._roomsByName[roomName]) return this._roomsByName[roomName];

    return this._gitter.rooms.findByUri(roomName).then((room) => {
        this._roomsByName[roomName] = room;
        return room;
    });
};

GitterGhost.prototype.send = function(roomName, text) {
    return this._getRoom(roomName).then((room) => {
        return room.send(text);
    });
};

GitterGhost.prototype.sendStatus = function(roomName, text) {
    return this._getRoom(roomName).then((room) => {
        return room.sendStatus(text);
    });
};

module.exports = GitterGhost;
