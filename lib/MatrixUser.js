"use strict";

var randomstring = require("randomstring");

/*
 * Represents a user we have seen from Matrix; i.e. a real Matrix user
 */

function MatrixUser(main, opts) {
    this._main = main;

    this._user_id = opts.user_id;

    this._atime = null; // last activity time in epoch seconds

    this._randomKey = null;
    this._gitterAccessToken = null;
    this._gitterGhost = null;
}

MatrixUser.fromEntry = function(main, entry) {
    if (entry.type !== "matrix") {
        throw new Error("Can only make MatrixUser out of entry.type == 'matrix'");
    }

    var u = new MatrixUser(main, {
        user_id: entry.id,
    });

    u._randomKey = entry.data.random_key;
    u._gitterAccessToken = entry.data.gitter_access_token;

    return u;
};

MatrixUser.prototype.toEntry = function() {
    return {
        type: "matrix",
        id: this._user_id,
        data: {
            random_key: this._randomKey,
            gitter_access_token: this._gitterAccessToken,
        },
    };
};

MatrixUser.prototype.userId = function() {
    return this._user_id;
};

// Returns a suitable displayname to identify the user within the given room,
//   taking into account disambiguation with other users in the same room.
MatrixUser.prototype.getDisplaynameForRoom = function(room_id) {
    var my_member_event = this._main.getStoredEvent(
        room_id, "m.room.member", this._user_id
    );

    if (!my_member_event || !my_member_event.content) {
        console.log("Did not find a member event for " + this._user_id + " in " + room_id);
        return null;
    }

    var displayname = my_member_event.content.displayname;

    if (displayname) {
        // To work out what displayname we can show requires us to work out if
        // the displayname is unique among them all. Which means we need to find
        // them all
        var member_events = this._main.getStoredEvent(
            room_id, "m.room.member"
        );

        var matching = member_events.filter(
            (ev) => ev.content && ev.content.displayname === displayname
        );

        if (matching.length > 1) {
            // Disambiguate
            displayname = displayname + " (" + this._user_id + ")";
        }
    }

    return displayname;
};

// Returns a (promise of a) GitterGhost
MatrixUser.prototype.getGitterGhost = function() {
    if (this._gitterGhost) return Promise.resolve(this._gitterGhost);

    var main = this._main;
    if (this._gitterAccessToken) {
        this._gitterGhost = main.createGitterGhost(this._gitterAccessToken);
    }
    else {
        this._gitterGhost = main.getRelayBotGitterGhost();
    }

    return Promise.resolve(this._gitterGhost);
};

MatrixUser.prototype.generateRandomKey = function() {
    var randkey = this._randomKey = randomstring.generate(12);

    return this._main.putUser(this).then(() => {
        return randkey;
    });
};

MatrixUser.prototype.checkRandomKey = function(randkey) {
    if (this._randomKey === null || randkey !== this._randomKey) {
        throw new Error("User randomkey state does not match");
    }

    // randomkey is one-use only; expire it
    this._randomKey = null;
    return this._main.putUser(this);
};

MatrixUser.prototype.setGitterAccessToken = function(token) {
    this._gitterAccessToken = token;
    // clear the cached ghost
    this._gitterGhost = null;

    return this._main.putUser(this);
};

MatrixUser.prototype.getATime = function() {
    return this._atime;
};

MatrixUser.prototype.bumpATime = function() {
    this._atime = Date.now() / 1000;
};

module.exports = MatrixUser;
