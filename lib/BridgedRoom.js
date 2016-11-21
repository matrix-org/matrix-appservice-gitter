"use strict";

var Promise = require("bluebird");

var retry = require("./retry");

// How often to clean up stale sent message IDs
var STALE_CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutes
// How old an ID has to be before we delete it
var STALE_ID_LIMIT = 3600 * 1000; // 1 hour

var JOIN_DELAY_STAGGER = 1000; // 1 second

// A *global* join time rate limiter, to try to avoid getting too many 429s
// from gitter on startup
var nextJoinNotBefore = Date.now();

function BridgedRoom(opts) {
    this._main = opts.main;
    this._gitter = opts.gitter;
    this._gitterRealtime = opts.gitterRealtime;
    this._gitterRoomName = opts.gitterRoomName;
    this._linkedMatrixRoomIds = [];
    this._portalMatrixRoomId = null;

    // Set as a side-effect of joinAndStart
    this._gitterStartingPromise = null;
    this._gitterUserId = null;
    this._gitterRoom = null;

    // The most recent message model object sent in this room from the gitter
    //   side, keyed by user ID. This is useful if the user sends an update,
    //   so we can diff it
    this._previousMessages = {};

    // A set containing "guard" promises representing all of the
    // currently-outstanding gitter send operations
    this._sendingGuards = new Set();

    // Map from gitter message IDs to timestamps when we sent them
    this._sentMessageIds = {};

    this._gitterAtime = null; // last activity time in epoch seconds
    this._matrixAtime = {};   //   keyed by matrix room ID
}

BridgedRoom.prototype.gitterRoomName = function() {
    return this._gitterRoomName;
};

BridgedRoom.prototype.linkMatrixRoom = function(matrixRoomId) {
    this._linkedMatrixRoomIds.push(matrixRoomId);
    this._matrixAtime[matrixRoomId] = null;
};

// returns a Promise, which will resolve to nothing. If the room needs to be
//   stopped and left on the gitter side because it has no matrix links
//   remaining, this promise will not resolve until that is done.
BridgedRoom.prototype.unlinkMatrixRoom = function(matrixRoomId) {
    this._linkedMatrixRoomIds = this._linkedMatrixRoomIds.filter((id) =>
        id !== matrixRoomId
    );
    delete this._matrixAtime[matrixRoomId];

    if (this._linkedMatrixRoomIds.length || this._portalMatrixRoomId) {
        // We still need the room - don't stop it on the gitter side yet
        return this._main.drainAndLeaveMatrixRoom(matrixRoomId);
    }

    return Promise.all([
        this.stopAndLeave(),
        this._main.drainAndLeaveMatrixRoom(matrixRoomId),
    ]);
};

BridgedRoom.prototype.getLinkedMatrixRoomIds = function() {
    return this._linkedMatrixRoomIds;
};

BridgedRoom.prototype.setPortalMatrixRoomId = function(matrixRoomId) {
    // TODO(paul): prevent non-null -> non-null transitions
    if (this._portalMatrixRoomId) {
        delete this._matrixAtime[this._portalMatrixRoomId];
    }

    this._portalMatrixRoomId = matrixRoomId;

    if (this._portalMatrixRoomId) {
        this._matrixAtime[this._portalMatrixRoomId] = null;
    }
};

BridgedRoom.prototype.getPortalMatrixRoomId = function() {
    return this._portalMatrixRoomId;
};

BridgedRoom.prototype.getAllMatrixRoomIds = function() {
    var ret = this._linkedMatrixRoomIds.slice(); // clone
    if (this._portalMatrixRoomId) ret.push(this._portalMatrixRoomId);
    return ret;
};

BridgedRoom.prototype.joinAndStart = function() {
    if (this._gitterStartingPromise) return this._gitterStartingPromise;

    // We have to find out our own gitter user ID so we can ignore reflections of
    // messages we sent
    return this._gitterStartingPromise = this._main.getMyGitterUserId().then((gitterUserId) => {
        this._gitterUserId = gitterUserId;

        this._main.incRemoteCallCounter("room.join");
        return retry(() => {
            var now = Date.now();
            var delay = nextJoinNotBefore - now;
            if (delay < 0) {
                delay = 0;
                nextJoinNotBefore = now + JOIN_DELAY_STAGGER;
            }
            else {
                nextJoinNotBefore += JOIN_DELAY_STAGGER;
            }

            return Promise.delay(delay).then(() => {
                return this._gitter.rooms.join(this.gitterRoomName());
            }).catch((e) => {
                // TODO(paul): It seems that the gitter instance gives us
                // HTTP failures as plain Error instances whose error
                // message string starts with the HTTP response code, as
                // the only vague indication what the failure was. This is
                // the best we can do.

                // HTTP failures look like: "404: ...."
                var matches = e.message.match(/^(\d+):/);
                if (!matches) throw e;
                var code = matches[1];

                // Turn 429 or any 5xx into RetryError
                if ((code == "429") || (code.match(/^5/))) {
                    throw new retry.RetryError(e.message);
                }

                throw e;
            });
        });
    }).then((room) => {
        this._gitterRoom = room;

        room.subscribe();

        room.on('chatMessages', (event) => {
            if (!event.model) return;
            var model = event.model;

            var operation = event.operation;
            if (operation !== 'create' && operation !== 'update') {
                return;
            }

            // Wait for all currently-pending send operations to complete
            //   so we'll have the full set of message IDs
            Promise.all(this._sendingGuards).then(() => {
                if (model.id in this._sentMessageIds) {
                    delete this._sentMessageIds[model.id];
                    return;
                }

                this.onGitterMessage(model);
            });
        });

        this._gitterRealtime.subscribe("/v1/rooms/" + room.id, (message) => {
            this._main.getGitterUser(message.userId).then((user) => {
                if (user) {
                    user.setRoomPresence(room.id, message.status == 'in');
                }
            });
        });

        this._cleanupIntervalId = setInterval(() => {
            var ids = this._sentMessageIds;
            var limit = Date.now() - STALE_ID_LIMIT;

            // Delete any stale sent message IDs older than an hour
            Object.keys(ids).forEach((id) => {
                if (ids[id] < limit) {
                    delete ids[id];
                }
            });
        }, STALE_CLEANUP_INTERVAL);
    });
};

BridgedRoom.prototype.stopAndLeave = function() {
    clearInterval(this._cleanupIntervalId);

    this._gitterRoom.unsubscribe();

    this._main.incRemoteCallCounter("room.leave");
    return this._gitterRoom.removeUser(this._gitterUserId);
};

function quotemeta(s) { return s.replace(/\W/g, '\\$&'); }

// idx counts backwards from the end of the string; 0 is final character
function rcharAt(s,idx) { return s.charAt(s.length-1 - idx); }

function firstWord(s) {
    var groups = s.match(/^\s*\S+/);
    return groups ? groups[0] : "";
}

function finalWord(s) {
    var groups = s.match(/\S+\s*$/);
    return groups ? groups[0] : "";
}

function htmlEscape(s) {
    return s.replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
}

BridgedRoom.prototype.onGitterMessage = function(message) {
    // Each message follows the model given in
    //   https://developer.gitter.im/docs/messages-resource
    var fromUser = message.fromUser;

    var user_id = fromUser.id;

    this._main.incCounter("received_messages", {side: "remote"});
    console.log('gitter->' + this.gitterRoomName() + ' from ' + fromUser.username + ':', message.text);

    var prevMessage;

    if (message.v > 1) {
        // versions above 1 are updates. Lets see if we have the previous
        // version
        prevMessage = this._previousMessages[user_id];
    }

    this._previousMessages[user_id] = message;

    this._main.getGitterUser(user_id, {
        create: true,
        username: fromUser.username,
    }).then((user) => {
        return user.update(fromUser)
            .catch((e) => {
                console.log("Updating user failed:", e);
                // There's a lot that could go wrong in user.update(); e.g. the avatar
                //   image could be corrupted and the matrix media server would reject
                //   it. Lets not let a failure there get in the way of message
                //   relaying - we'll ignore the failure here and continue anyway.
            }).then(() => {
                return user;
            });
    }).then((user) => {
        var matrixMessage = {
            msgtype: "m.text",
            body: message.text,
        };

        if (prevMessage) {
            // Matrix doesn't (yet) support message edits. See
            //   https://matrix.org/jira/browse/SPEC-410
            //
            // For now we'll note that 99% of edits in gitter are people
            //   performing little typo fixes or other small edits. We'll
            //   detect a common prefix and suffix and show only the edited
            //   region in a helpfully marked-up way.

            var prev = prevMessage.text;
            var curr = message.text;

            // TODO(paul): for now I'll ignore diffing of formatted messages
            //   because I really don't fancy an HTML-tagged formatting aware
            //   version of this algorithm

            // Find the length of the common prefix and suffix

            // TODO(paul): this code all sucks. It works fine in BMP unicode
            //   without combining marks. It will break in the presence of
            //   non-BMP codepoints (because of split UTF-16 surrogates) or
            //   differences in combining marks on the same base character.
            //   I don't fancy fixing this right now.
            var i;
            for (i = 0; i < curr.length && i < prev.length; i++) {
                if (curr.charAt(i) != prev.charAt(i)) break;
            }
            // retreat to the start of a word
            while(i > 0 && /\S/.test(curr.charAt(i-1))) i--;

            var prefixLen = i;

            for(i = 0; i < curr.length && i < prev.length; i++) {
                if (rcharAt(curr, i) != rcharAt(prev, i)) break;
            }
            // advance to the end of a word
            while(i > 0 && /\S/.test(rcharAt(curr, i-1))) i--;

            var suffixLen = i;

            // Extract the common prefix and suffix strings themselves and
            //   mutate the prev/curr strings to only contain the differing
            //   middle region
            var prefix = curr.slice(0, prefixLen);
            curr = curr.slice(prefixLen);
            prev = prev.slice(prefixLen);

            var suffix = "";
            if (suffixLen > 0) {
                suffix = curr.slice(-suffixLen);
                curr = curr.slice(0, -suffixLen);
                prev = prev.slice(0, -suffixLen);
            }

            // At this point, we have four strings; the common prefix and
            //   suffix, and the edited middle part. To display it nicely as a
            //   matrix message we'll use the final word of the prefix and the
            //   first word of the suffix as "context" for a customly-formatted
            //   message.

            var before = finalWord(prefix);
            if (before != prefix) { before = "... " + before; }

            var after = firstWord(suffix);
            if (after != suffix) { after = after + " ..."; }

            matrixMessage.body = "(edited) " +
                before + prev + after + " => " +
                before + curr + after;

            prev   = htmlEscape(prev);
            curr   = htmlEscape(curr);
            before = htmlEscape(before);
            after  = htmlEscape(after);

            matrixMessage.format = "org.matrix.custom.html";
            matrixMessage.formatted_body = "<i>(edited)</i> " +
                before + '<font color="red">'   + prev + '</font>' + after + " =&gt; " +
                before + '<font color="green">' + curr + '</font>' + after;
        }
        else {
            // Pull out the HTML part of the body if it's not just plain text
            if (message.html != message.text) {
                matrixMessage.format = "org.matrix.custom.html";
                matrixMessage.formatted_body = message.html;
            }

            if (message.status) {
                matrixMessage.msgtype = "m.emote";

                // Strip the leading @username mention from the body text
                var userNameQuoted = quotemeta(fromUser.username);

                // Turn  "@username does something here" into "does something here"
                matrixMessage.body =
                    matrixMessage.body.replace(new RegExp("^@" + userNameQuoted + " "), "");

                // HTML is harder. Applying regexp mangling to an HTML string. Not a lot
                //   better we can do about this, unless gitter gives us the underlying
                //   message in a better way.

                // Turn
                //   <span class="mention" ...>@username</span> does something here
                // into
                //   does something here
                matrixMessage.formatted_body =
                    matrixMessage.formatted_body.replace(new RegExp("^<span [^>]+>@" + userNameQuoted + "</span> "), "");
            }
        }

        this.getAllMatrixRoomIds().forEach((matrixRoomId) => {
            return user.sendMessage(matrixRoomId, matrixMessage).then(() => {
                this._main.incCounter("sent_messages", {side: "matrix"});
            });
        });

        user.bumpATime();
        this._gitterAtime = Date.now() / 1000;
    });
};

BridgedRoom.prototype.onMatrixMessage = function(message) {
    this._main.incCounter("received_messages", {side: "matrix"});

    var user_id = message.user_id;

    return Promise.all([
        this._main.getOrCreateMatrixUser(user_id),
        this._main.getOrCreateGitterGhost(user_id),

        this._gitterStartingPromise,
    ]).spread((user, ghost) => {
        var displayname = user.getDisplaynameForRoom(message.room_id);

        var from = this._main.mangleName(user.userId(), displayname);

        if (!from) {
            console.log("Could not work out a 'from' name for " + user.userId() +
                    "; fallback to user ID");
            // Fallback to raw user ID
            from = message.user_id;
        }

        var send_p = this.sendToGitter(message, ghost, from).then((result) => {
            var id = result.id;
            this._sentMessageIds[id] = Date.now();

            this._main.incCounter("sent_messages", {side: "remote"});

            user.bumpATime();
            this._matrixAtime[message.room_id] = Date.now() / 1000;

            // Reflect the message to other Matrix rooms linked to the same Gitter one
            // These appear using the bot's own user acting as a ghost for the things
            //   it said on the Gitter side.
            this.getAllMatrixRoomIds().forEach((matrixRoomId) => {
                if (matrixRoomId === message.room_id) return;

                this._main.getBotIntent().sendMessage(
                    matrixRoomId, {
                        msgtype: "m.text",
                        body: "`"+from+"` "+message.content.body,

                        format: "org.matrix.custom.html",
                        formatted_body: "<code>"+from+"</code> "+message.content.body,
                    }
                ).then(() => {
                    this._main.incCounter("sent_messages", {side: "remote"});
                });
            });
        });

        // A "guard promise"; one that never fails
        var guard_p = send_p.catch((e) => {});

        this._sendingGuards.add(guard_p);
        guard_p.then(() => {
            this._sendingGuards.delete(guard_p);
        });
    });
};

BridgedRoom.prototype.sendToGitter = function(message, ghost, from) {
    var msgtype = message.content.msgtype;

    // gitter supports Markdown. We'll use that to apply a little formatting
    // to make understanding the text a little easier
    if (msgtype == 'm.emote') {
        // wrap emote messages in *italics*
        // We'll have to also escape any *s in the message so they don't confuse
        //   markdown

        var text = message.content.body.replace(/\*/g, '\\*');

        if (!ghost.isPuppet()) {
            text = from.replace(/\*/g, '\\*') + ' ' + text;
        }

        return ghost.sendStatus(this._gitterRoomName, '*' + text + '*');
    }
    else if (msgtype == 'm.image') {
        if (!message.content.url) {
            console.log("Ignoring m.image with missing URL");
            this.incCounter("dropped_messages", {side: "matrix"});
            return Promise.resolve();
        }
        var image_url = this._main.getUrlForMxc(message.content.url);
        // If we just paste markdown with the image URL directly into gitter,
        // clients will cope
        var text = '![' + message.content.body + '](' + image_url + ')';

        if (!ghost.isPuppet()) {
            text = '`' + from + '` posted an image: ' + text;
        }

        return ghost.send(this._gitterRoomName, text);
    }
    else {
        if (msgtype !== 'm.text') {
            console.log("TODO: Might want to specially handle msgtype=" + msgtype);
        }

        var text = message.content.body;

        if (!ghost.isPuppet()) {
            // wrap the sender of a normal message in `fixedwidth` notation
            text = '`' + from + '` ' + text;
        }

        return ghost.send(this._gitterRoomName, text);
    }
};

BridgedRoom.prototype.getGitterATime = function() {
    return this._gitterAtime;
};

BridgedRoom.prototype.getMatrixATimes = function() {
    return this._matrixAtime;
};

module.exports = BridgedRoom;
