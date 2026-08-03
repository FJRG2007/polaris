/**
 * WAF edge-guard wire format. A route's denylist + require-login rule is carried to
 * the co-located edge guard in the `X-Polaris-Waf` request header, which Traefik
 * stamps onto the request (so a client cannot forge it) via a `headers` middleware
 * chained ahead of the `forwardAuth` guard. Keeping this codec in one place keeps
 * the three producers/consumers (the local router, the remote label builder, and
 * the guard itself) byte-compatible. Node-only (uses Buffer/crypto), so it is
 * imported via "@polaris/core/waf" and never from the client-safe barrel.
 */

import { expandWafPresets } from "./waf-presets.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { wafCustomRuleSchema, type WafCustomRule } from "./schemas/deploy.js";

/** The per-route rule the guard enforces. Empty denylist, no packs, no custom rules
 *  and no login = a no-op. */
export interface GuardRule {
    readonly deny: readonly string[];
    readonly requireLogin: boolean;
    /** Refuse requests whose headers do not hold together as a browser's. Optional on
     *  the way in (an older edge config predates it), always present on the way out. */
    readonly browserIntegrity?: boolean;
    /** Refuse requests whose URL carries a SQL injection payload. Optional on the way
     *  in (an older edge config predates it), always present on the way out. */
    readonly sqlInjectionProtection?: boolean;
    /** Refuse requests whose URL carries a cross-site scripting payload. Separate from
     *  the SQL check above: a scope can arm either on its own. */
    readonly xssProtection?: boolean;
    /** Rewrite email addresses in served HTML. Carried here rather than in a config of
     *  its own so one header describes everything the guard does to a route - but note
     *  it is the only entry the forwardAuth path ignores, because it changes the
     *  response and forwardAuth never sees one. */
    readonly emailObfuscation?: boolean;
    /** Managed rule-pack ids, expanded to rules on decode. Sending ids rather than
     *  their contents is what keeps this header small: a pack of forty user agents
     *  is four bytes here and is stamped onto every single request to the route.
     *  Optional on the way in, always present on the way out. */
    readonly presets?: readonly string[];
    /** Custom rules in evaluation order, broadest scope first. */
    readonly rules: readonly WafCustomRule[];
}

/** Encode a guard rule for the X-Polaris-Waf header (base64 of compact JSON:
 *  `d` = denylist, `l` = require-login, `b` = browser integrity, `s` = SQL injection
 *  protection, `x` = XSS protection, `e` = email obfuscation, `p` = pack ids,
 *  `r` = custom rules). */
export function encodeGuardRule(rule: GuardRule): string {
    return Buffer.from(
        JSON.stringify({
            d: rule.deny,
            l: rule.requireLogin,
            b: rule.browserIntegrity === true,
            s: rule.sqlInjectionProtection === true,
            x: rule.xssProtection === true,
            e: rule.emailObfuscation === true,
            p: rule.presets ?? [],
            r: rule.rules
        })
    ).toString("base64");
}

const EMPTY_RULE: GuardRule = {
    deny: [],
    requireLogin: false,
    browserIntegrity: false,
    sqlInjectionProtection: false,
    xssProtection: false,
    emailObfuscation: false,
    presets: [],
    rules: []
};
/** Everything a rule can refuse with, for a header that arrived unreadable. Both
 *  injection checks are on here even though the empty rule leaves them off: the empty
 *  rule is "no rule was attached", this one is "a rule was attached and we cannot read
 *  it". */
const FAIL_CLOSED: GuardRule = {
    deny: [],
    requireLogin: true,
    browserIntegrity: false,
    sqlInjectionProtection: true,
    xssProtection: true,
    emailObfuscation: false,
    presets: [],
    rules: []
};

/**
 * Decoded headers, keyed by the header itself.
 *
 * Every request to a route carries the same header - Traefik stamps one constant
 * string - so decoding it per request means base64, JSON.parse and a full Zod
 * re-validation of every rule on the hot path, for a result that cannot have
 * changed. The cache turns that into one Map lookup. It is bounded and evicts in
 * insertion order because the key space is "routes on this edge", not user input:
 * only Traefik can set this header, so it cannot be grown by an attacker.
 */
const DECODED = new Map<string, GuardRule>();
const DECODED_MAX = 256;

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
 *
 * Rule packs are expanded here and appended *after* the operator's own rules, so a
 * hand-written `allow` still takes precedence over a managed `block` - the pack is
 * the broad policy and the custom rule above it is the exception.
 */
export function decodeGuardRule(header: string | undefined | null): GuardRule {
    if (!header) return EMPTY_RULE;
    const cached = DECODED.get(header);
    if (cached) return cached;

    const decoded = decodeUncached(header);
    if (DECODED.size >= DECODED_MAX) {
        const oldest = DECODED.keys().next();
        if (!oldest.done) DECODED.delete(oldest.value);
    }
    DECODED.set(header, decoded);
    return decoded;
}

function decodeUncached(header: string): GuardRule {
    try {
        const raw: unknown = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
        if (raw && typeof raw === "object") {
            const obj = raw as {
                d?: unknown;
                l?: unknown;
                b?: unknown;
                i?: unknown;
                s?: unknown;
                x?: unknown;
                e?: unknown;
                p?: unknown;
                r?: unknown;
            };
            const deny = Array.isArray(obj.d) ? obj.d.filter((v): v is string => typeof v === "string") : [];
            const presets = Array.isArray(obj.p) ? obj.p.filter((v): v is string => typeof v === "string") : [];
            // `i` is the single injection flag the two below were split out of. A route
            // materialized before the split still carries it, and keeps both checks
            // until its edge is rewritten - dropping one silently on upgrade would be a
            // protection removed by a deploy nobody asked to change anything.
            const legacy = obj.i === true;
            return {
                deny,
                requireLogin: obj.l === true,
                browserIntegrity: obj.b === true,
                sqlInjectionProtection: obj.s === true || legacy,
                xssProtection: obj.x === true || legacy,
                emailObfuscation: obj.e === true,
                presets,
                rules: [...parseRules(obj.r), ...expandWafPresets(presets)]
            };
        }
    } catch {
        // Fall through to the fail-closed default below.
    }
    return FAIL_CLOSED;
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
 * The upstream a proxied route forwards to, signed.
 *
 * The guard is normally a forwardAuth check and never learns where the request is
 * really going. Email obfuscation changes the response, so for those routes the guard
 * IS the target and Traefik tells it the real upstream in a header - which turns an
 * unsigned header into an open proxy into the server's own network the moment anything
 * lets a client-supplied one through. Traefik's `customRequestHeaders` overwrites a
 * client's value, so that alone would probably hold; "probably" is not the standard
 * for something whose failure mode is arbitrary internal requests, so it is signed
 * with the secret the guard already has.
 */
export function signEdgeOrigin(origin: string, secret: string): string {
    const payload = Buffer.from(origin).toString("base64url");
    return `${payload}.${createHmac("sha256", secret).update(`origin:${payload}`).digest("base64url")}`;
}

/** The upstream from a signed value, or null if it is missing, malformed, tampered
 *  with, or not an http(s) URL. An empty secret is rejected outright, for the same
 *  reason it is in verifyEdgeToken: an empty HMAC key makes any value forgeable. */
export function verifyEdgeOrigin(value: string | undefined | null, secret: string): string | null {
    if (!value || !secret) return null;
    const dot = value.indexOf(".");
    if (dot <= 0 || dot === value.length - 1) return null;
    const payload = value.slice(0, dot);
    const provided = Buffer.from(value.slice(dot + 1));
    const expected = Buffer.from(createHmac("sha256", secret).update(`origin:${payload}`).digest("base64url"));
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
    try {
        const origin = Buffer.from(payload, "base64url").toString("utf8");
        const url = new URL(origin);
        return url.protocol === "http:" || url.protocol === "https:" ? origin : null;
    } catch {
        return null;
    }
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
