/**
 * The pass a player's claim carries, so everybody in the call can tell that the
 * server let this seat play this game.
 *
 * A claim rides in an attribute the player's own browser writes, so on its own
 * it proves nothing: anybody holding a seat could write one. The pass is minted
 * only after the server checked the account holds `arcade.calls`, and it signs
 * the call, the seat, the game and the moment of joining, so it opens nothing
 * in any other call, for any other seat, and cannot be lifted onto another
 * claim. Signed with the app secret every install already has, so it needs no
 * configuration.
 *
 * Server-only.
 */

import { loadEnv } from "@polaris/config";
import { createHmac, timingSafeEqual } from "node:crypto";
import { PASS_TTL_MS } from "./call-activity";

/**
 * How long a pass stays good. Short on purpose: a player's browser renews it
 * while they play (see `RENEW_BEFORE_MS`), and every renewal asks again
 * whether they hold `arcade.calls`, so taking the permission away removes them
 * from the game within this window - every other browser stops counting a
 * claim whose pass has run out.
 */
export { PASS_TTL_MS } from "./call-activity";

export interface PassFacts {
    readonly meetingId: string;
    readonly seat: string;
    readonly game: string;
    readonly at: number;
}

function sign(facts: PassFacts, expires: string, secret: string): string {
    return createHmac("sha256", secret)
        .update(
            `call-activity:${facts.meetingId}:${facts.seat}:${facts.game}:${facts.at}:${expires}`
        )
        .digest("base64url");
}

/** A pass for one seat playing one game in one call. */
export function activityPass(
    facts: PassFacts,
    now = Date.now(),
    secret = loadEnv().POLARIS_AUTH_SECRET
): string {
    const expires = String(now + PASS_TTL_MS);
    return `${expires}.${sign(facts, expires, secret)}`;
}

/** Whether a pass was minted for exactly these facts, and is still good. */
export function readActivityPass(
    pass: string,
    facts: PassFacts,
    now = Date.now(),
    secret = loadEnv().POLARIS_AUTH_SECRET
): boolean {
    const [expires, signature, extra] = pass.split(".");
    if (!expires || !signature || extra !== undefined || !/^\d{10,16}$/.test(expires)) return false;
    if (Number(expires) < now) return false;
    const expected = Buffer.from(sign(facts, expires, secret), "utf8");
    const given = Buffer.from(signature, "utf8");
    return expected.length === given.length && timingSafeEqual(expected, given);
}
