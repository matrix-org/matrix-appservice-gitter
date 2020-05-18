import * as logging from "./Logging";
import Bluebird from "bluebird";

const log = logging.Get("retry");


export class RetryError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RetryError";
    }
}

/*
 * Repeatedly calls 'code()' until it does not fail with a RetryError.
 * When it succeeds, or fails with a different kind of error, or when we run
 * out of attempt counts, its result or failure is returned.
 */
export function retry<T>(code: () => Promise<T>) {
    var attempts = 10;
    var delay = 200; // msec

    const again: () => Promise<T> = () => {
        return code().catch((e) => {
            attempts--;
            if (!attempts || !(e instanceof RetryError)) {
                log.error("Failed permanently:", e);
                throw e;
            }

            // Avoid thundering "herd" by staggering +/- 20%
            var factor = 0.8 + (Math.random() * 0.4);
            // factor is between 0.8 and 1.2

            var thisDelay = delay * factor;
            delay *= 2;

            log.warn("Failed:", e.message, "retrying after "+thisDelay+"msec");
            return Bluebird.delay(thisDelay).then(
                () => again()
            );
        });
    }
    return again();
}