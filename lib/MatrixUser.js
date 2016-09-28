"use strict";

/*
 * Represents a user we have seen from Matrix; i.e. a real Matrix user. We
 * don't currently have the ability to create Gitter-side ghosts, so all these
 * users appear via a single relaybot.
 */

function MatrixUser(bridge, opts) {
    this._bridge = bridge;

    this._user_id = opts.user_id;
}

MatrixUser.prototype.userId = function() {
    return this._user_id;
};

module.exports = MatrixUser;
