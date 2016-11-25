"use strict";

var Promise = require("bluebird");

/**
 * Constructs a new RateLimiter whose timeslots do not occur more frequently
 * than the given interval.
 */
function RateLimiter(interval) {
    this._interval = interval;

    this._nextNotBefore = Date.now();
}

/**
 * Returns a Promise that will resolve at the next available timeslot. The
 * factor argument applies a multiplication on the usual interval, to account
 * for more expensive operations.
 */
RateLimiter.prototype.next = function(factor) {
    factor = factor || 1;

    var now = Date.now();
    var delay = this._nextNotBefore - now;
    if (delay < 0) {
        delay = 0;
        this._nextNotBefore = now + this._interval * factor;
        return Promise.resolve();
    }
    else {
        this._nextNotBefore += this._interval * factor;
        return Promise.delay(delay);
    }
};

module.exports = RateLimiter;
