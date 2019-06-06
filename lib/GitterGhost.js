"use strict";
const crypto = require('crypto');

const LASTMESSAGE_TTL_MS = 12 * 60 * 60 * 1000;
const LASTMESSAGE_REAP_INTERVAL = 60 * 1000;

const log = require("./Logging.js").Get("GitterGhost");

function GitterGhost(opts) {
    this._main = opts.main;
    this._gitter = opts.gitter;
    this._is_puppet = opts.is_puppet || false;
    this._rateLimiter = opts.rateLimiter;
    this._messageDuplicationCount = {
        // msg => {
        //    time: number
        //    count: number
        //}
    };

    // Do this regularly to reclaim memory.
    setInterval(() => {
        Object.keys(this._messageDuplicationCount).forEach((text) => {
            const d = this._messageDuplicationCount[text];
            if (d.time + LASTMESSAGE_TTL_MS < Date.now) {
                delete this._messageDuplicationCount[text];
            }
        });
    }, LASTMESSAGE_REAP_INTERVAL);

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
            this._main.incRemoteCallCounter("room.findByUri");
            return this._roomsByName[roomName] = room;
        });
    });
};

GitterGhost.prototype._couldBeBanned = function(text) {
    /*
        Gitter bans users for sending too many messages with the same has in a set period (12 hours).
        It's rather impractical, but the best way to deal with this is to pre-empt them and check the 
        thesholds ourselves by storing all the hashes locally. Gitter also do not make any distinction
        about the destination room where the message may be sent, so we must apply these limits globally
        which is a bit lame.
     */
    const hash = crypto.createHash('md5').update(text).digest('hex');
    // Lifted from https://gitlab.com/gitlab-org/gitter/webapp/blob/develop/modules/spam-detection/lib/duplicate-chat-detector.js#L26
    let threshold = 8;
    if (text.length < 10) {
        threshold = 80;
    }
    else if (text.length < 20) {
        threshold = 16;
    }

    const dupes = this._messageDuplicationCount[hash];
    if (!dupes || dupes.time + LASTMESSAGE_TTL_MS < Date.now) {
        this._messageDuplicationCount[hash] = {
            time: Date.now(),
            count: 1,
        };
    }
    else if (dupes.count > threshold) {
        return true;
    } else {
        this._messageDuplicationCount[hash].count++;
        return dupes.count > threshold;
    }
}

GitterGhost.prototype.send = function(roomName, text) {
    if (this._couldBeBanned(text)) {
        log.warn(`Ghost has hit local anti-spam threshold (in room ${roomName})`);
        throw Error("Not sending message, ghost is above ban threshold for spam");
    }
    return this._getRoom(roomName).then((room) => {
        return this._rateLimiter.next().then(() => {
            this._main.incRemoteCallCounter("room.send");
            return room.send(text);
        });
    });
};

GitterGhost.prototype.sendStatus = function(roomName, text) {
    return this._getRoom(roomName).then((room) => {
        return this._rateLimiter.next().then(() => {
            this._main.incRemoteCallCounter("room.send");
            return room.sendStatus(text);
        });
    });
};

module.exports = GitterGhost;
