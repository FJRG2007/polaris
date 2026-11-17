/**
 * The pass a delivered page's frame reads the files beside it with.
 *
 * The page is drawn in a sandboxed frame with an opaque origin, and a frame
 * like that is a different site as far as cookies go: what it loads arrives
 * without the session cookie (see `lib/mailbox/image-token.ts`, where this was
 * measured). So the address carries its own authority: which page, for whom,
 * until when, signed with the app secret every install already has. The route
 * still asks on every request whether that person may read the page, so a
 * share taken back closes the pass with it.
 *
 * Server-only.
 */

import { loadEnv } from "@polaris/config";
import { createHmac, timingSafeEqual } from "node:crypto";

/** How long a pass stays good: a page left open for a working day still draws. */
export const FRAME_PASS_TTL_MS = 12 * 60 * 60 * 1000;

const PASS = /^([A-Za-z0-9_-]{1,300})\.([A-Za-z0-9_-]{20,100})$/;

function sign(payload: string): string {
    return createHmac("sha256", loadEnv().POLARIS_AUTH_SECRET)
        .update(`agent-artifact-frame:${payload}`)
        .digest("base64url");
}

/** A pass for `userId` to read the page `artifactId` and what is beside it. */
export function mintFramePass(artifactId: string, userId: string, now = Date.now()): string {
    const payload = Buffer.from(`${artifactId}:${userId}:${now + FRAME_PASS_TTL_MS}`, "utf8").toString(
        "base64url"
    );
    return `${payload}.${sign(payload)}`;
}

/** Who a pass was minted for, when it is good for exactly this page; else null. */
export function readFramePass(artifactId: string, pass: string, now = Date.now()): string | null {
    const match = PASS.exec(pass);
    if (!match) return null;
    const [, payload, signature] = match as unknown as [string, string, string];
    const expected = Buffer.from(sign(payload), "utf8");
    const given = Buffer.from(signature, "utf8");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const [id, userId, expires, ...rest] = Buffer.from(payload, "base64url").toString("utf8").split(":");
    if (rest.length > 0 || id !== artifactId || !userId || userId.length > 100) return null;
    const until = Number(expires);
    if (!Number.isSafeInteger(until) || until <= now) return null;
    return userId;
}
