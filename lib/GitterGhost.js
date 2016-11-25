"use strict";

function GitterGhost(opts) {
    this._gitter = opts.gitter;
    this._is_puppet = opts.is_puppet || false;
    this._rateLimiter = opts.rateLimiter;

    this._roomsByName = {};
}

GitterGhost.prototype.isPuppet = function() {
    return this._is_puppet;
};

GitterGhost.prototype._getRoom = function(roomName) {
    var room = this._roomsByName[roomName];
    if (room) {
        return Promise.resolve(room);
    }

    return this._rateLimiter.next().then(() => {
        return this._gitter.rooms.findByUri(roomName).then((room) => {
            return this._roomsByName[roomName] = room;
        });
    });
};

GitterGhost.prototype.send = function(roomName, text) {
    return this._getRoom(roomName).then((room) => {
        return this._rateLimiter.next().then(() => room.send(text));
    });
};

GitterGhost.prototype.sendStatus = function(roomName, text) {
    return this._getRoom(roomName).then((room) => {
        return this._rateLimiter.next().then(() => room.sendStatus(text));
    });
};

module.exports = GitterGhost;
