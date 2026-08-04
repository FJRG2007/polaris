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
import { wafCustomRuleSchema, type WafCustomRule, type WafPrincipalGrant } from "./schemas/deploy.js";

/** The per-route rule the guard enforces. Empty denylist, no packs, no custom rules,
 *  no principal lists and no login = a no-op. */
export interface GuardRule {
    readonly deny: readonly string[];
    readonly requireLogin: boolean;
    /**
     * Where the guard sends a visitor to sign in, without a trailing slash.
     *
     * Carried per route rather than read from the guard's own environment, because the
     * environment is written once when the sidecar is deployed and the address Polaris
     * answers on is a setting an operator changes afterwards. A guard that redirected to
     * the address it was born with would send anyone off the LAN to a name that resolves
     * nowhere, which is exactly what the LAN default (`polaris.local`) does.
     *
     * Optional: an edge config written before this existed carries no such key, and the
     * guard falls back to its environment as it always did.
     */
    readonly loginUrl?: string;
    /**
     * One principal list per scope that admitted anybody; a visitor must satisfy every
     * one of them. Empty (the common case) means the login admits any account, which
     * is what `requireLogin` meant before there was anything to narrow it with.
     *
     * Optional on the way in - an edge config written before this existed carries no
     * such key, and its route admits any account exactly as it did - and always
     * present on the way out.
     */
    readonly loginAllowLists?: readonly (readonly WafPrincipalGrant[])[];
    /** Principals refused whatever admits them, unioned across scopes. Checked before
     *  the lists above and never overridden by them. */
    readonly loginDeny?: readonly WafPrincipalGrant[];
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

/**
 * Encode a guard rule for the X-Polaris-Waf header (base64 of compact JSON: `d` =
 * denylist, `l` = require-login, `a` = where to sign in, `n` = the principal lists that
 * login admits, `y` = the principals it refuses, `b` = browser integrity, `s` = SQL
 * injection protection, `x` = XSS protection, `e` = email obfuscation, `p` = pack ids,
 * `r` = custom rules).
 *
 * The login keys are left out entirely when they say nothing, which is the case on
 * essentially every route. They decode to the same empty result either way, and this
 * header is stamped onto every single request to every route on the instance - so a key
 * that would always be there and always say nothing is worth not sending.
 */
export function encodeGuardRule(rule: GuardRule): string {
    const allowLists = (rule.loginAllowLists ?? []).filter((list) => list.length > 0);
    const deny = rule.loginDeny ?? [];
    const loginUrl = rule.requireLogin ? normalizeLoginUrl(rule.loginUrl) : null;
    return Buffer.from(
        JSON.stringify({
            d: rule.deny,
            l: rule.requireLogin,
            ...(loginUrl ? { a: loginUrl } : {}),
            ...(allowLists.length > 0 ? { n: allowLists.map(encodeGrants) } : {}),
            ...(deny.length > 0 ? { y: encodeGrants(deny) } : {}),
            b: rule.browserIntegrity === true,
            s: rule.sqlInjectionProtection === true,
            x: rule.xssProtection === true,
            e: rule.emailObfuscation === true,
            p: rule.presets ?? [],
            r: rule.rules
        })
    ).toString("base64");
}

/** Grants on the wire: `r` = the principal, `f`/`u` = the window, both left out when
 *  the entry simply applies (which is most of them). */
function encodeGrants(grants: readonly WafPrincipalGrant[]): Record<string, unknown>[] {
    return grants.map((grant) => ({
        r: grant.ref,
        ...(grant.from !== undefined ? { f: grant.from } : {}),
        ...(grant.until !== undefined ? { u: grant.until } : {})
    }));
}

/**
 * An absolute http(s) origin with no trailing slash, or null.
 *
 * Checked rather than trusted because the value ends up in a `Location` header: only
 * Traefik can set the rule header, but a misconfigured address must fail to a login
 * that does not happen rather than to a redirect somewhere unintended.
 */
function normalizeLoginUrl(value: string | undefined): string | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
        return null;
    }
}

const EMPTY_RULE: GuardRule = {
    deny: [],
    requireLogin: false,
    loginAllowLists: [],
    loginDeny: [],
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
    // Empty rather than a list nobody satisfies: an unreadable header should send the
    // visitor to a login, not refuse every account on the instance including the
    // operator on their way to fix it.
    loginAllowLists: [],
    loginDeny: [],
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
                a?: unknown;
                n?: unknown;
                y?: unknown;
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
                loginUrl: normalizeLoginUrl(typeof obj.a === "string" ? obj.a : undefined) ?? undefined,
                loginAllowLists: parsePrincipalLists(obj.n),
                loginDeny: parseGrants(obj.y),
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

/**
 * The allowlists that survive decoding, in the order they were encoded.
 *
 * A list that decodes to nothing is dropped rather than kept as an empty one: an empty
 * list would be a constraint no visitor can satisfy, so a garbled entry would lock
 * everyone out of the route instead of leaving the remaining lists to decide. The
 * refusal that matters - the login itself - is carried by `requireLogin` and is not
 * affected either way.
 */
function parsePrincipalLists(value: unknown): WafPrincipalGrant[][] {
    if (!Array.isArray(value)) return [];
    const lists: WafPrincipalGrant[][] = [];
    for (const entry of value) {
        const list = parseGrants(entry);
        if (list.length > 0) lists.push(list);
    }
    return lists;
}

/**
 * The grants that survive decoding.
 *
 * A garbled entry is dropped rather than kept with its window lost: an entry whose
 * expiry failed to decode would go on admitting somebody the operator had already
 * written an end date for, which is the one way this can fail that nobody would notice.
 */
function parseGrants(value: unknown): WafPrincipalGrant[] {
    if (!Array.isArray(value)) return [];
    const grants: WafPrincipalGrant[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== "object") continue;
        const { r, f, u } = entry as { r?: unknown; f?: unknown; u?: unknown };
        if (typeof r !== "string" || r.length === 0) continue;
        if ((f !== undefined && typeof f !== "number") || (u !== undefined && typeof u !== "number")) continue;
        grants.push({ ref: r, from: f as number | undefined, until: u as number | undefined });
    }
    return grants;
}

/** How a login rule answers one signed-in visitor. */
export type PrincipalVerdict = "admitted" | "refused" | "not-admitted";

/**
 * Whether a visitor holding `held` gets past a rule's principal lists at `now`
 * (unix seconds).
 *
 * Deny first and final, then the allowlists: each one ANDs and its own entries OR, so a
 * scope names who it admits and every scope that named anybody gets a veto - which is
 * what lets a narrower scope restrict a broader one's list and never widen it. An entry
 * outside its window is not there at all, on either side. No lists and no denials is the
 * "any account" case and passes, so this is safe to call unconditionally.
 *
 * Lives here rather than in either caller because both the guard (deciding a request)
 * and Polaris (deciding whether to mint a token for one) have to answer it the same way.
 * Two implementations of this are two answers, and the disagreement would show up as a
 * redirect loop between them rather than as a wrong page.
 */
export function principalVerdict(
    rule: Pick<GuardRule, "loginAllowLists" | "loginDeny">,
    held: ReadonlySet<string>,
    now: number
): PrincipalVerdict {
    const applies = (grant: WafPrincipalGrant): boolean =>
        held.has(grant.ref) &&
        (grant.from === undefined || now >= grant.from) &&
        (grant.until === undefined || now < grant.until);

    if ((rule.loginDeny ?? []).some(applies)) return "refused";
    const lists = rule.loginAllowLists ?? [];
    if (lists.length === 0) return "admitted";
    return lists.every((list) => list.some(applies)) ? "admitted" : "not-admitted";
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
    /**
     * When this token was minted, unix seconds.
     *
     * What makes `prn` below correctable. Membership is a statement about a moment,
     * and the guard needs to know which moment in order to tell a token that predates
     * somebody's group change from one that reflects it.
     *
     * Absent on a token minted before this existed; the guard reads that as "older
     * than anything it could be compared against", which sends its holder back for one
     * that can be.
     */
    readonly iat?: number;
    /**
     * The principals this token proves its holder resolved to when it was minted -
     * themselves, their groups, and their roles - so the guard can answer "may THIS
     * account in?" offline, the way it already answers "is this account signed in?".
     *
     * Absent means the token was minted before Polaris carried membership at all. That
     * is not the same as "belongs to nothing", and the guard treats it differently:
     * see `evaluate` in the edge guard, which re-mints instead of refusing.
     *
     * This is a claim about `iat`, not about now. Polaris publishes when each account's
     * membership last moved, so a claim the change has overtaken is spotted at the edge
     * and re-minted - see `membershipStale`. Absent that snapshot the claim still ages
     * out on its own, because the guard will not act on one older than
     * MEMBERSHIP_MAX_AGE_SECONDS when a rule actually names principals.
     */
    readonly prn?: readonly string[];
}

/**
 * How old a token's membership claim may be before a rule that names principals stops
 * acting on it.
 *
 * The backstop, not the mechanism: when the snapshot reaches the edge a change is
 * noticed within seconds, and this only matters where it does not - a server whose
 * guard has no snapshot volume, or one that has not received a fresh file. Half an
 * hour rather than minutes, because the price of aging out is a redirect, and a
 * redirect in the middle of a page's background request is not free.
 *
 * Only routes that actually name principals pay it. Everywhere else a token is worth
 * its full life, which is what keeps this off the overwhelming majority of requests.
 */
export const MEMBERSHIP_MAX_AGE_SECONDS = 30 * 60;

/**
 * How long a minted edge token is valid. After this the visitor re-authenticates,
 * which requires Polaris to be reachable again.
 *
 * Shared rather than owned by the endpoint that mints them, because the snapshot of
 * re-decided accounts is pruned to exactly this window: an entry older than the longest
 * a token can live can only concern tokens that have already expired. Two copies of
 * this number drifting apart would silently shorten that window.
 */
export const EDGE_TOKEN_TTL_SECONDS = 8 * 60 * 60;

/** Sign an edge token as `<payload>.<sig>` (HMAC-SHA256 over the payload). Mirrors
 *  the signed-cookie HMAC pattern used elsewhere (access-lock/share/file-request).
 *  `prn` and `iat` are always written, so a token minted by a current Polaris is
 *  always distinguishable from one that predates membership. */
export function signEdgeToken(token: EdgeToken, secret: string): string {
    const payload = Buffer.from(
        JSON.stringify({
            sub: token.sub,
            aud: token.aud,
            exp: token.exp,
            iat: token.iat ?? Math.floor(Date.now() / 1000),
            prn: token.prn ?? []
        })
    ).toString("base64url");
    const sig = createHmac("sha256", secret).update(`edge:${payload}`).digest("base64url");
    return `${payload}.${sig}`;
}

/**
 * Whether Polaris has re-decided this account since the token was minted.
 *
 * `movedAt` (epoch ms) is what Polaris publishes when an account's groups or roles
 * change, when it is banned, or when its sessions are revoked - anything that makes a
 * token's account claim out of date. Absent for essentially every account at any
 * moment, so this costs one Map lookup and answers "no".
 *
 * Asked for EVERY token, not only where a rule names principals, because "this account
 * may no longer come in at all" is not a question about the rule. Before this, revoking
 * somebody's sessions did not reach a service already serving them: the guard verifies
 * tokens offline, and the token outlived the session by hours.
 *
 * A token with no `iat` cannot be compared, so a known change supersedes it.
 */
export function principalsSuperseded(token: { readonly iat?: number }, movedAt: number | null): boolean {
    if (movedAt === null) return false;
    return token.iat === undefined || movedAt > token.iat * 1000;
}

/**
 * Whether a token's membership claim is too old to decide a rule that names principals,
 * at `now` (unix seconds).
 *
 * The backstop for an edge the snapshot never reaches: without it, a guard with no
 * published stamps would act on whatever membership the token was born with for its
 * whole life. A token with no `iat` carries a claim with no moment attached, which is
 * precisely what cannot be checked, so it is too old by definition.
 */
export function membershipTooOld(token: { readonly iat?: number }, now: number): boolean {
    if (token.iat === undefined) return true;
    return now - token.iat > MEMBERSHIP_MAX_AGE_SECONDS;
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
            const obj = raw as { sub?: unknown; aud?: unknown; exp?: unknown; iat?: unknown; prn?: unknown };
            if (
                typeof obj.sub === "string" &&
                typeof obj.aud === "string" &&
                typeof obj.exp === "number" &&
                obj.exp > now &&
                (audience === undefined || obj.aud === audience)
            ) {
                // Both left undefined when the payload carries neither, which is how a
                // token minted before membership existed stays recognisable as one.
                const prn = Array.isArray(obj.prn)
                    ? obj.prn.filter((v): v is string => typeof v === "string")
                    : undefined;
                const iat = typeof obj.iat === "number" ? obj.iat : undefined;
                return { sub: obj.sub, aud: obj.aud, exp: obj.exp, iat, prn };
            }
        }
    } catch {
        // Fall through to null (invalid payload).
    }
    return null;
}
