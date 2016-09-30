"use strict";

/*
 * Represents a user we have seen from Gitter; i.e. a real Gitter user who
 * likely has a Matrix-side ghost
 */

var Promise = require("bluebird");

var rp = require("request-promise");

// miliseconds of interval between presence=online updates
var ONLINE_PERIOD_MSEC = 4 * 60 * 1000;

// miliseconds of grace period before users count as offline
var OFFLINE_GRACE_MSEC = 3 * 60 * 1000;

function GitterUser(bridge, opts) {
    this._bridge = bridge;

    this._gitter_id = opts.id;
    this._mxid_localpart = opts.mxid_localpart;
    this._username = opts.username;
    this._display_name = opts.display_name;
    this._avatar_url = opts.avatar_url;

    this._presentInRooms = new Set();
    this._ispresent = false;
    this._intent = null;
    this._presenceIntervalId = null; // ID returned from setInterval()
    this._presenceDelayId = null;    // ID returned from setTimeout()

    this._atime = null; // last activity time in epoch seconds
}

GitterUser.fromEntry = function(bridge, entry) {
    return new GitterUser(bridge, {
        id: entry.id,
        mxid_localpart: entry.data.mxid_localpart,
        username: entry.data.username,
        display_name: entry.data.display_name,
        avatar_url: entry.data.avatar_url,
    });
};

GitterUser.prototype.toEntry = function() {
    return {
        type: "remote", // for current database format
        id: this._gitter_id,
        data: {
            username: this._username,
            mxid_localpart: this._mxid_localpart,
            display_name: this._display_name,
            avatar_url: this._avatar_url,
        },
    };
};

GitterUser.prototype.gitterId = function() {
    return this._gitter_id;
};

GitterUser.prototype.gitterUsername = function() {
    return this._username;
};

GitterUser.prototype.getIntent = function() {
    // Prefer a locally cached ID, but fallback on generating one from the
    //   gitter username for legacy users
    var mxid_localpart = this._mxid_localpart ||
        this._bridge.localpartFromGitterName(this.gitterUsername());

    return this._intent = this._intent || (
        this._bridge.getIntentFromLocalpart(mxid_localpart)
    );
};

GitterUser.prototype.update = function(user) {
    return Promise.all([
        this.updateDisplayName(user.displayName),
        this.updateAvatar(user.avatarUrlMedium)
    ]);
};

GitterUser.prototype.updateDisplayName = function(name) {
    if (this._display_name == name) {
        return Promise.resolve();
    }

    var intent = this.getIntent();

    this._bridge.incMatrixCallCounter("setDisplayName");
    return intent.setDisplayName(name + ' (Gitter)').then(() => {
        this._display_name = name;

        return this._bridge.putRemoteUser(this);
    });
};

GitterUser.prototype.updateAvatar = function(url) {
    if (this._avatar_url == url) {
        return Promise.resolve();
    }

    console.log("Updating " + this.gitterUsername() + " avatar image from " + url);

    var intent = this.getIntent();

    return rp({
        uri: url,
        resolveWithFullResponse: true,
        encoding: null
    }).then((response) => {
        var content_type = response.headers["content-type"];

        this._bridge.incMatrixCallCounter("uploadContent");
        return intent.getClient().uploadContent({
            stream: new Buffer(response.body, "binary"),
            name: "avatar.jpg",
            type: content_type,
        });
    }).then((response) => {
        var content_uri = JSON.parse(response).content_uri;

        console.log("Media uploaded to " + content_uri);
        this._bridge.incMatrixCallCounter("setAvatarUrl");
        return intent.setAvatarUrl(content_uri);
    }).then(() => {
        this._avatar_url = url;

        return this._bridge.putRemoteUser(this);
    });
};

GitterUser.prototype.setRoomPresence = function(room_id, present) {
    if (present) {
        this._presentInRooms.add(room_id);
    }
    else {
        this._presentInRooms.delete(room_id);
    }

    this.updatePresence(this._presentInRooms.size > 0);
};

GitterUser.prototype.updatePresence = function(present) {
    if (present == this._ispresent) return;

    this._ispresent = present;

    if (present) {
        if (this._presenceDelayId) {
            clearTimeout(this._presenceDelayId);
            this._presenceDelayId = null;
            return;
        }

        console.log("ONLINE " + this.gitterUsername());

        this._bridge.incMatrixCallCounter("setPresence");
        this.getIntent().getClient().setPresence("online");

        this._presenceIntervalId = setInterval(() => {
            this._bridge.incMatrixCallCounter("setPresence");
            this.getIntent().getClient().setPresence("online");
        }, ONLINE_PERIOD_MSEC);
    }
    else {
        this._presenceDelayId = setTimeout(() => {
            clearInterval(this._presenceIntervalId);
            this._presenceDelayId = null;

            console.log("OFFLINE " + this.gitterUsername());
            this._bridge.incMatrixCallCounter("setPresence");
            this.getIntent().getClient().setPresence("unavailable");
        }, OFFLINE_GRACE_MSEC);
    }

};

GitterUser.prototype.getATime = function() {
    return this._atime;
};

GitterUser.prototype.bumpATime = function() {
    this._atime = Date.now() / 1000;
};

module.exports = GitterUser;
