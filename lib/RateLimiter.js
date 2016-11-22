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
 * Returns a Promise that will resolve at the next available timeslot.
 */
RateLimiter.prototype.next = function() {
    var now = Date.now();
    var delay = this._nextNotBefore - now;
    if (delay < 0) {
        delay = 0;
        this._nextNotBefore = now + this._interval;
        return Promise.resolve();
    }
    else {
        this._nextNotBefore += this._interval;
        return Promise.delay(delay);
    }
};

module.exports = RateLimiter;
