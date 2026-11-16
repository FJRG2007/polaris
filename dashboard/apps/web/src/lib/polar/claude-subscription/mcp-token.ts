/**
 * The token a subscription turn hands Claude Code for Polaris's own tools on
 * `/api/mcp`: one per turn, naming the person and the turn, good for as long
 * as a turn may take.
 *
 * Signed with the app secret every install already has, so it needs no
 * configuration and is read on any node. It carries no scopes of its own: the
 * MCP route grants what the person holds at the moment of each call
 * (`sessionScopes`), so a ban or a lost permission reaches a turn already
 * running at once.
 *
 * Server-only.
 */

import { z } from "zod";
import { loadEnv } from "@polaris/config";
import { createHmac, timingSafeEqual } from "node:crypto";

export const TURN_TOKEN_PREFIX = "pct_";
/** How long a turn's token stays good: the longest a turn is expected to run. */
export const TURN_TOKEN_TTL_MS = 60 * 60 * 1000;

const claimsSchema = z.object({ u: z.string().min(1).max(64), t: z.string().uuid(), e: z.number().int() });

function sign(body: string, secret: string): string {
    return createHmac("sha256", secret).update(`polar-chat-mcp:${body}`).digest("base64url");
}

/** A token for one turn of one person. */
export function mintTurnToken(userId: string, turnId: string, now = Date.now(), secret = loadEnv().POLARIS_AUTH_SECRET): string {
    const body = Buffer.from(JSON.stringify({ u: userId, t: turnId, e: now + TURN_TOKEN_TTL_MS }), "utf8").toString("base64url");
    return `${TURN_TOKEN_PREFIX}${body}.${sign(body, secret)}`;
}

/** The person and turn a token was minted for, or null for one that is
 *  forged, altered or expired. */
export function readTurnToken(
    token: string,
    now = Date.now(),
    secret = loadEnv().POLARIS_AUTH_SECRET
): { userId: string; turnId: string } | null {
    if (!token.startsWith(TURN_TOKEN_PREFIX) || token.length > 600) return null;
    const [body, signature] = token.slice(TURN_TOKEN_PREFIX.length).split(".");
    if (!body || !signature) return null;
    const expected = Buffer.from(sign(body, secret), "utf8");
    const given = Buffer.from(signature, "utf8");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    let raw: unknown;
    try {
        raw = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
        return null;
    }
    const claims = claimsSchema.safeParse(raw);
    if (!claims.success || claims.data.e < now) return null;
    return { userId: claims.data.u, turnId: claims.data.t };
}
