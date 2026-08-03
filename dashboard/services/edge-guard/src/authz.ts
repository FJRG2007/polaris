/**
 * Pure WAF decision for the edge guard. Traefik forwardAuth calls the guard for
 * every request to a protected route; this function turns the forwarded request
 * headers into an allow (200) / block (403) / login-redirect (302) decision. It is
 * intentionally I/O-free and deterministic so it can be unit-tested exhaustively -
 * the HTTP wrapper in server.ts only marshals headers in and a status out.
 *
 * The per-route rule (denylist, custom rules, injection protection, require-login)
 * arrives in the `X-Polaris-Waf` header, which a Traefik `headers` middleware stamps
 * on the request, so a client cannot forge it. Deny is checked first: a denied IP is blocked even if
 * logged in. The custom rules run next, in order, and the first one to match decides
 * - which is what lets a narrow `allow` sit above a broad `block` without the two
 * contradicting each other.
 *
 * Require-login uses a cross-domain handoff, because Polaris (which owns the login
 * session) and the app usually sit on different domains and cannot share a cookie:
 *   1. No valid token -> 302 to Polaris `/edge/authorize?redirect=<original>`.
 *   2. Polaris signs a host-bound token and 302s back to the app's `/edge/callback`.
 *   3. The guard sees `/edge/callback`, verifies the token, and 302s to the original
 *      URL with a same-domain `Set-Cookie`. Subsequent requests carry the cookie and
 *      are verified offline - so access survives a Polaris outage until the token
 *      expires. The token is bound to the app host (`aud`), so it cannot be replayed
 *      against another app even if it leaks via the callback URL.
 */

import { decodeGuardRule, verifyEdgeToken } from "@polaris/core/waf";
import {
    browserIntegrityFailure,
    evaluateWafRules,
    injectionFailure,
    ipAllowed,
    type WafIntelIndex
} from "@polaris/core";

/** Path (on the app's own domain) the login handoff returns to. */
const CALLBACK_PATH = "/edge/callback";

/** The forwarded request facts the guard decides on (all from Traefik headers). */
export interface GuardRequest {
    readonly wafHeader?: string;
    readonly forwardedFor?: string;
    readonly forwardedProto?: string;
    readonly forwardedHost?: string;
    readonly forwardedUri?: string;
    readonly forwardedMethod?: string;
    readonly userAgent?: string;
    /** Read only by the browser integrity check, which is about the shape of the
     *  request rather than about what it asked for. */
    readonly accept?: string;
    readonly acceptLanguage?: string;
    readonly acceptEncoding?: string;
    readonly cookie?: string;
}

export interface GuardConfig {
    /** Shared HMAC secret (POLARIS_AUTH_SECRET) used to verify edge tokens. */
    readonly secret: string;
    /** Polaris base URL the guard redirects to for a login (e.g. https://polaris). */
    readonly authorizeUrl: string;
    /** Edge-token cookie name (e.g. "polaris.edge"). */
    readonly cookieName: string;
    /** Current time in unix seconds (injected for deterministic tests). */
    readonly now: number;
    /** Bans, Tor exits and flagged addresses, held in memory. Omitted in tests that
     *  are not about it, which is the same as an empty list. */
    readonly intel?: WafIntelIndex;
}

export type GuardDecision =
    | { readonly status: 200 }
    | { readonly status: 403; readonly reason: string }
    | { readonly status: 302; readonly location: string; readonly setCookie?: string };

/** The originating client IP as Traefik forwarded it (leftmost X-Forwarded-For). */
function clientIp(forwardedFor: string | undefined): string | null {
    if (!forwardedFor) return null;
    const first = forwardedFor.split(",")[0]?.trim();
    return first && first.length > 0 ? first : null;
}

/** Extract one cookie value from a Cookie header, or undefined if absent. */
function readCookie(header: string | undefined, name: string): string | undefined {
    if (!header) return undefined;
    for (const part of header.split(";")) {
        const eq = part.indexOf("=");
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return undefined;
}

/** Parse the forwarded request URI against its own origin. Null if unparseable. */
function parseUri(uri: string | undefined, proto: string, host: string | undefined): URL | null {
    if (!uri || !host) return null;
    try {
        return new URL(uri, `${proto}://${host}`);
    } catch {
        return null;
    }
}

/** The absolute original URL of the request (for the post-login return trip). */
function originalUrl(req: GuardRequest, proto: string): string | undefined {
    return req.forwardedHost ? `${proto}://${req.forwardedHost}${req.forwardedUri ?? "/"}` : undefined;
}

/** Build the Polaris login URL to redirect an unauthenticated visitor to. */
function loginRedirect(cfg: GuardConfig, req: GuardRequest, proto: string): string {
    const original = originalUrl(req, proto) ?? cfg.authorizeUrl;
    return `${cfg.authorizeUrl}/edge/authorize?redirect=${encodeURIComponent(original)}`;
}

/** Confine a post-login redirect to the app's own host, so the guard is never an
 *  open redirector. Falls back to the app root. */
function sameHostRedirect(target: string | null, proto: string, host: string): string {
    if (target) {
        try {
            const url = new URL(target);
            if (url.host === host) return url.toString();
        } catch {
            // Not an absolute URL; fall through to the root.
        }
    }
    return `${proto}://${host}/`;
}

/** Serialize the edge-token cookie (Secure only on https, so plain-HTTP edges work). */
function buildCookie(name: string, value: string, secure: boolean, maxAge: number): string {
    const attrs = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
    if (secure) attrs.push("Secure");
    return attrs.join("; ");
}

/** Decide whether to allow, block, or redirect a forwarded request. */
export function evaluate(req: GuardRequest, cfg: GuardConfig): GuardDecision {
    const proto = req.forwardedProto || "https";
    const host = req.forwardedHost;
    const rule = decodeGuardRule(req.wafHeader);

    // Deny first: a denied IP is blocked everywhere, including the login handoff.
    if (rule.deny.length > 0) {
        const ip = clientIp(req.forwardedFor);
        if (!ip) return { status: 403, reason: "client ip unknown" };
        if (ipAllowed(ip, rule.deny)) return { status: 403, reason: "denied ip" };
    }

    // Then the out-of-band list: an address Polaris banned for what it did, a Tor
    // exit, or one a reputation provider flagged. Checked before the custom rules
    // because it is the cheapest test here (one Map lookup) and because a banned
    // address should not be able to talk its way past with a well-chosen header.
    if (cfg.intel && cfg.intel.size > 0) {
        const hit = cfg.intel.match(clientIp(req.forwardedFor), cfg.now * 1000);
        if (hit) return { status: 403, reason: `intel: ${hit.reason}${hit.note ? ` (${hit.note})` : ""}` };
    }

    // Custom rules next, before the login handoff: a rule that admits a request is
    // meant to admit it, and one that blocks it should not first be sent round a
    // login it was never going to be allowed past.
    if (rule.rules.length > 0) {
        const uri = parseUri(req.forwardedUri, proto, host);
        const verdict = evaluateWafRules(rule.rules, {
            ip: clientIp(req.forwardedFor),
            host,
            path: uri?.pathname ?? req.forwardedUri ?? null,
            method: req.forwardedMethod,
            userAgent: req.userAgent,
            query: uri?.search.replace(/^\?/, "") ?? null
        });
        if (verdict?.action === "block") return { status: 403, reason: `rule: ${verdict.rule.name}` };
        if (verdict?.action === "allow") return { status: 200 };
    }

    // After the custom rules too, and before the integrity check because it is the more
    // precise of the two: when a request would fail both, "sql union select in the
    // query" tells an operator what happened and "no user agent" does not.
    //
    // The URI is split rather than parsed. `new URL` would allocate and re-encode on a
    // check that runs for every request on every route, and the raw request line is
    // what should be scanned anyway - the signatures are matched against the bytes the
    // client actually sent, after this check's own decoding.
    if (rule.injectionProtection === true) {
        const uri = req.forwardedUri ?? "";
        const split = uri.indexOf("?");
        const failure = injectionFailure({
            path: split < 0 ? uri : uri.slice(0, split),
            query: split < 0 ? null : uri.slice(split + 1),
            userAgent: req.userAgent
        });
        if (failure) return { status: 403, reason: `injection: ${failure}` };
    }

    // After the custom rules, deliberately. This is a heuristic and every heuristic is
    // wrong about something; putting it here means an operator who finds the thing it
    // is wrong about writes an `allow` above it, which is the same exception mechanism
    // every other block on this path already has.
    if (rule.browserIntegrity === true) {
        const failure = browserIntegrityFailure({
            userAgent: req.userAgent,
            accept: req.accept,
            acceptLanguage: req.acceptLanguage,
            acceptEncoding: req.acceptEncoding
        });
        if (failure) return { status: 403, reason: `browser integrity: ${failure}` };
    }

    if (rule.requireLogin) {
        // Without a host we can neither bind/verify the token's audience nor build a
        // redirect, so fail closed rather than admit the request.
        if (!host) return { status: 403, reason: "host unknown" };
        const uri = parseUri(req.forwardedUri, proto, host);
        // Login handoff back from Polaris: mint the URL token into a same-domain cookie.
        if (uri && uri.pathname === CALLBACK_PATH) {
            const token = uri.searchParams.get("token") ?? "";
            const verified = verifyEdgeToken(token, cfg.secret, cfg.now, host);
            if (verified) {
                const maxAge = Math.max(1, verified.exp - cfg.now);
                return {
                    status: 302,
                    location: sameHostRedirect(uri.searchParams.get("redirect"), proto, host),
                    setCookie: buildCookie(cfg.cookieName, token, proto === "https", maxAge)
                };
            }
            return { status: 302, location: loginRedirect(cfg, req, proto) };
        }
        const token = readCookie(req.cookie, cfg.cookieName);
        if (verifyEdgeToken(token, cfg.secret, cfg.now, host)) return { status: 200 };
        return { status: 302, location: loginRedirect(cfg, req, proto) };
    }
    return { status: 200 };
}
