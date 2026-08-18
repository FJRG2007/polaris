/**
 * The running build, as an opaque stamp two tabs can compare.
 *
 * Hashed rather than sent as it is: the endpoint that serves this answers without
 * a session, and a build number handed to anyone who asks is a list of the flaws a
 * deployment has not been updated past yet. Nothing needs the commit itself - the
 * only question asked of this value is whether it is still the same one.
 *
 * Null on a build that carries no stamp (a source build, a dev run). The caller
 * reads that as "cannot tell" and says nothing, rather than comparing nothings and
 * announcing an update on every poll.
 */

import { createHash } from "node:crypto";

/** Long enough that two builds cannot collide, short enough to stay a stamp. */
const LENGTH = 16;

export function buildStamp(): string | null {
    const sha = (process.env.POLARIS_BUILD_SHA ?? "").trim();
    return sha ? createHash("sha256").update(sha).digest("hex").slice(0, LENGTH) : null;
}
