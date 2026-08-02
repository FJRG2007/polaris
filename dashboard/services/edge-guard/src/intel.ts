/**
 * The guard's copy of the address intelligence: automatic bans, Tor exits, and
 * whatever a reputation provider flagged.
 *
 * Polaris writes a snapshot file into a volume this container mounts read-only; this
 * holds the parsed index in memory and hands it to `evaluate`. Two properties matter
 * and both are about the hot path:
 *
 *   - No I/O per request. The file's mtime is checked at most once a second, and only
 *     a change re-reads it. Between changes a lookup is a Map hit.
 *   - No network per request, ever. Whether an address is a Tor exit or was flagged
 *     by a provider was decided out of band, minutes ago, by Polaris.
 *
 * A missing, unreadable or foreign-version file indexes to nothing and the guard
 * carries on with the rules it was given. That direction is deliberate: this list can
 * only ever block traffic, so failing to read it must fail open. The header-carried
 * rules, which can also *grant* access, fail closed - see decodeGuardRule.
 */

import { statSync, readFileSync } from "node:fs";
import { indexWafIntel, type WafIntelIndex } from "@polaris/core";

/** How often the file is allowed to be stat'ed, in ms. A ban is published on the
 *  order of a minute, so a second of staleness here costs nothing and takes the
 *  syscall off all but one request per second. */
const CHECK_EVERY_MS = 1000;

export interface IntelSource {
    /** The current index, reloading first if the file changed. */
    current(now: number): WafIntelIndex;
}

/** Watch `path` for changes and keep its parsed index. `now` is injected so tests
 *  drive the throttle instead of sleeping. */
export function createIntelSource(path: string | undefined): IntelSource {
    let index = indexWafIntel(null);
    let checkedAt = -Infinity;
    let seenMtime = -1;
    if (!path) return { current: () => index };

    return {
        current(now) {
            if (now - checkedAt < CHECK_EVERY_MS) return index;
            checkedAt = now;
            try {
                const mtime = statSync(path).mtimeMs;
                if (mtime === seenMtime) return index;
                seenMtime = mtime;
                index = indexWafIntel(JSON.parse(readFileSync(path, "utf8")));
            } catch {
                // Gone, truncated mid-write, or not valid JSON. Keep the last good
                // index rather than dropping every ban because one read raced a
                // write - the next tick picks up the finished file.
            }
            return index;
        }
    };
}
