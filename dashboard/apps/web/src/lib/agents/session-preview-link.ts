/**
 * The address a session's previews are served under, and the check of it. On
 * its own, with nothing but the secret behind it, so the boot environment can
 * name it without reaching for the proxy (see `session-preview`).
 *
 * The signature is the session's id signed with the app secret every install
 * already has: stable for the life of the session, so the agent can be told it
 * and serve under it, and minted only by Polaris.
 *
 * Server-only.
 */

import { loadEnv } from "@polaris/config";
import { createHmac, timingSafeEqual } from "node:crypto";

/** Where every preview is served under. */
export const PREVIEW_ROOT = "/api/agents/preview";

function sign(sessionId: string): string {
    return createHmac("sha256", loadEnv().POLARIS_AUTH_SECRET)
        .update(`agent-preview:${sessionId}`)
        .digest("base64url");
}

/** The path a session's previews are served under; a port follows it. */
export function previewBase(sessionId: string): string {
    return `${PREVIEW_ROOT}/${sessionId}/${sign(sessionId)}`;
}

/** Whether `signature` was minted for exactly this session. */
export function readPreviewSignature(sessionId: string, signature: string): boolean {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(signature)) return false;
    const expected = Buffer.from(sign(sessionId), "utf8");
    const given = Buffer.from(signature, "utf8");
    return expected.length === given.length && timingSafeEqual(expected, given);
}

/** A port as a path names it, or null. */
export function previewPort(raw: string): number | null {
    if (!/^\d{1,5}$/.test(raw)) return null;
    const port = Number(raw);
    return port >= 1 && port <= 65535 ? port : null;
}
