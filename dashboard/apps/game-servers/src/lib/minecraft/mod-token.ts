/**
 * The key in the address a server downloads Polaris's jars from.
 *
 * The jars are several megabytes, and an address anybody can fetch is an address
 * anybody can fetch ten thousand times: a bill and a saturated uplink for the
 * operator, which is the whole point of that kind of attack. So the address a
 * server is given carries this key, and the route refuses one without it.
 *
 * Derived rather than stored, like the pack links (`client-pack`): the
 * instance's own secret over a fixed label, so there is nothing to keep or
 * migrate, and rotating the secret retires every address - which the component
 * sweep then rewrites on every server.
 */

import { loadEnv } from "@polaris/config";
import { createHmac, timingSafeEqual } from "node:crypto";

export function modToken(): string {
    const secret = loadEnv().POLARIS_AUTH_SECRET || "";
    return createHmac("sha256", secret)
        .update("minecraft-mod-download")
        .digest("base64url")
        .slice(0, 32);
}

/** Whether a key is this instance's, compared without leaking where it first
 *  differs. */
export function modTokenMatches(token: string): boolean {
    const expected = Buffer.from(modToken());
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given);
}
