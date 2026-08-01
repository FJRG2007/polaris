/**
 * WAF edge-guard wire format. A route's denylist + require-login rule is carried to
 * the co-located edge guard in the `X-Polaris-Waf` request header, which Traefik
 * stamps onto the request (so a client cannot forge it) via a `headers` middleware
 * chained ahead of the `forwardAuth` guard. Keeping this codec in one place keeps
 * the three producers/consumers (the local router, the remote label builder, and
 * the guard itself) byte-compatible. Node-only (uses Buffer/crypto), so it is
 * imported via "@polaris/core/waf" and never from the client-safe barrel.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { wafCustomRuleSchema, type WafCustomRule } from "./schemas/deploy.js";

/** The per-route rule the guard enforces. Empty denylist, no custom rules and no
 *  login = a no-op. */
export interface GuardRule {
    readonly deny: readonly string[];
    readonly requireLogin: boolean;
    /** Custom rules in evaluation order, broadest scope first. */
    readonly rules: readonly WafCustomRule[];
}

/** Encode a guard rule for the X-Polaris-Waf header (base64 of compact JSON:
 *  `d` = denylist, `l` = require-login, `r` = custom rules). */
export function encodeGuardRule(rule: GuardRule): string {
    return Buffer.from(JSON.stringify({ d: rule.deny, l: rule.requireLogin, r: rule.rules })).toString("base64");
}

/**
 * Decode the X-Polaris-Waf header. Fails closed on a malformed value: a present but
 * unreadable header yields `requireLogin = true` (with an empty denylist), so a
 * corrupted rule demands a login rather than silently dropping protection. An
 * absent header means the guard was reached with no rule attached and is treated as
 * a no-op (the header/forwardAuth pair is only chained when a rule exists).
 *
 * The custom rules are re-validated rather than trusted as shapes: they are executed
 * against every request on the route, and a half-decoded rule would either throw in
 * the guard's hot path or silently match nothing. One unreadable rule is dropped and
 * the rest still run.
 */
export function decodeGuardRule(header: string | undefined | null): GuardRule {
    if (!header) return { deny: [], requireLogin: false, rules: [] };
    try {
        const raw: unknown = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
        if (raw && typeof raw === "object") {
            const obj = raw as { d?: unknown; l?: unknown; r?: unknown };
            const deny = Array.isArray(obj.d) ? obj.d.filter((v): v is string => typeof v === "string") : [];
            return { deny, requireLogin: obj.l === true, rules: parseRules(obj.r) };
        }
    } catch {
        // Fall through to the fail-closed default below.
    }
    return { deny: [], requireLogin: true, rules: [] };
}

/** The custom rules that survive validation, in the order they were encoded. */
function parseRules(value: unknown): WafCustomRule[] {
    if (!Array.isArray(value)) return [];
    const rules: WafCustomRule[] = [];
    for (const entry of value) {
        const parsed = wafCustomRuleSchema.safeParse(entry);
        if (parsed.success) rules.push(parsed.data);
    }
    return rules;
}

/**
 * A signed edge-access token. Polaris mints it after a normal login; the co-located
 * guard verifies it offline with the shared secret, so a logged-in visitor keeps
 * access even while Polaris is down (only minting a NEW token needs Polaris up).
 * `sub` is the user id, `aud` the app hostname the token is valid for (so a token
 * handed to one app can never be replayed against another), `exp` a unix-seconds
 * expiry.
 */
export interface EdgeToken {
    readonly sub: string;
    readonly aud: string;
    readonly exp: number;
}

/** Sign an edge token as `<payload>.<sig>` (HMAC-SHA256 over the payload). Mirrors
 *  the signed-cookie HMAC pattern used elsewhere (access-lock/share/file-request). */
export function signEdgeToken(token: EdgeToken, secret: string): string {
    const payload = Buffer.from(JSON.stringify({ sub: token.sub, aud: token.aud, exp: token.exp })).toString(
        "base64url"
    );
    const sig = createHmac("sha256", secret).update(`edge:${payload}`).digest("base64url");
    return `${payload}.${sig}`;
}

/**
 * Verify an edge token constant-time, check its expiry against `now` (unix seconds),
 * and (when `audience` is given) that its `aud` matches the requesting host. Returns
 * the token on success, or null if it is missing, malformed, tampered, expired, or
 * bound to a different host. An empty secret is rejected outright - an empty HMAC key
 * makes the MAC publicly computable, so any token would forge, so a guard with no
 * secret configured must trust nothing and fail closed. Never throws.
 */
export function verifyEdgeToken(
    value: string | undefined | null,
    secret: string,
    now: number,
    audience?: string
): EdgeToken | null {
    if (!value || !secret) return null;
    const dot = value.indexOf(".");
    if (dot <= 0 || dot === value.length - 1) return null;
    const payload = value.slice(0, dot);
    const provided = Buffer.from(value.slice(dot + 1));
    const expected = Buffer.from(createHmac("sha256", secret).update(`edge:${payload}`).digest("base64url"));
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
    try {
        const raw: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (raw && typeof raw === "object") {
            const obj = raw as { sub?: unknown; aud?: unknown; exp?: unknown };
            if (
                typeof obj.sub === "string" &&
                typeof obj.aud === "string" &&
                typeof obj.exp === "number" &&
                obj.exp > now &&
                (audience === undefined || obj.aud === audience)
            ) {
                return { sub: obj.sub, aud: obj.aud, exp: obj.exp };
            }
        }
    } catch {
        // Fall through to null (invalid payload).
    }
    return null;
}
