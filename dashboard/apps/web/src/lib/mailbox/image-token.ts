/**
 * The pass a picture in a message carries.
 *
 * A message is drawn inside a sandboxed frame with no same-origin privileges -
 * that is the whole defence, and it is not negotiable. What it costs is the
 * session: a frame with an opaque origin is a different site as far as cookies
 * are concerned, so a `SameSite=Lax` cookie is not sent with anything that frame
 * asks for. Measured rather than assumed - an image requested from inside such a
 * frame arrives with `SameSite=None` cookies only, and Polaris' session cookie
 * is not one of those and must never become one.
 *
 * So every picture came back 401 and no message showed any of its images, which
 * looked like the proxy being broken rather than the reader being anonymous to
 * it.
 *
 * The address carries its own authority instead. Polaris signs the three things
 * that matter - which message, which picture in it, and who it was drawn for -
 * so the route can answer without a session and still narrow the lookup to that
 * person's own mail. Nobody can mint one: the signature is over the app secret
 * every install already has, so this needs no new configuration to work on a
 * deployment that has been running for a year.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { loadEnv } from "@polaris/config";

/**
 * How long a signed address stays good.
 *
 * A day, because a reading pane left open overnight should still draw its
 * pictures in the morning, and because the browser is told it may cache them for
 * exactly as long - an address that expired while its picture was still cached
 * would be one that works until a reload and then stops.
 */
const TTL_MS = 24 * 60 * 60 * 1000;

/** What was signed. */
export interface ImagePass {
    readonly messageId: string;
    readonly index: number;
    readonly userId: string;
}

function sign(payload: string): string {
    return createHmac("sha256", loadEnv().POLARIS_AUTH_SECRET).update(payload).digest("base64url");
}

/** The address a message's picture is drawn from. */
export function imageUrl(pass: ImagePass): string {
    const expires = Date.now() + TTL_MS;
    const payload = Buffer.from(
        `${pass.messageId}:${pass.index}:${pass.userId}:${expires}`,
        "utf8"
    ).toString("base64url");
    return `/api/mail/image/${pass.messageId}/${pass.index}/${payload}.${sign(payload)}`;
}

/**
 * Who a signed address was made for, or nothing.
 *
 * The message and the position are checked against the ones in the path as well
 * as against the signature, so a pass for one picture cannot be moved onto
 * another by editing the address around it.
 */
export function readImagePass(token: string, messageId: string, index: number): ImagePass | null {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return null;

    const expected = Buffer.from(sign(payload), "utf8");
    const given = Buffer.from(signature, "utf8");
    // Compared in constant time, and only once the lengths agree - `timingSafeEqual`
    // throws on a mismatch rather than answering false.
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

    const parts = Buffer.from(payload, "base64url").toString("utf8").split(":");
    if (parts.length !== 4) return null;
    const [signedMessage, signedIndex, userId, expires] = parts as [string, string, string, string];
    if (signedMessage !== messageId || Number(signedIndex) !== index) return null;
    if (!userId || !Number(expires) || Number(expires) < Date.now()) return null;

    return { messageId, index, userId };
}

/** What the browser may keep a picture for. Kept under the pass's own life, so a
 *  cached picture never outlives the address that fetched it. */
export const IMAGE_CACHE_SECONDS = Math.floor(TTL_MS / 1000);
