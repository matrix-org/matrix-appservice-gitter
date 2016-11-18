"use strict";

var Promise = require("bluebird");

/*
 * Repeatedly calls 'code()' until it does not fail with a RetryError.
 * When it succeeds, or fails with a different kind of error, or when we run
 * out of attempt counts, its result or failure is returned.
 */
function retry(code) {
    var attempts = 10;
    var delay = 200; // msec

    function again() {
        return code().catch((e) => {
            attempts--;
            if (!attempts || !(e instanceof RetryError)) {
                console.log("Failed permanently:", e);
                throw e;
            }

            console.log("Failed:", e.message, "retrying after "+delay+"msec");
            return Promise.delay(delay).then(() => {
                delay *= 2;
                return again();
            });
        });
    }
    return again();
}

function RetryError(message) {
    this.name = "RetryError";
    this.message = message || "Retryable Error";
    this.stack = (new Error()).stack;
}
RetryError.prototype = Object.create(Error.prototype);
RetryError.prototype.constructor = RetryError;

retry.RetryError = RetryError;

module.exports = retry;
