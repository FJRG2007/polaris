/**
 * Clickjacking protection: which sites may show a page inside a frame of their own.
 *
 * On by default for every service behind a Polaris edge, and for Polaris itself. The
 * answer is "this site, plus whatever origins the operator lists", sent as
 * `Content-Security-Policy: frame-ancestors 'self' ...` with `X-Frame-Options:
 * SAMEORIGIN` beside it for browsers that predate the first.
 *
 * The hard part is not sending the headers, it is not breaking an app that already
 * decided. Two rules settle that, and both are about what a browser actually does:
 *
 *  - Several `Content-Security-Policy` headers are several policies, and a browser
 *    enforces every one of them. So the edge never edits an app's own policy: when the
 *    app sent no `frame-ancestors` it ADDS a policy holding only that directive, which
 *    leaves the app's script and style rules exactly as they were.
 *  - Every current browser ignores `X-Frame-Options` once a `frame-ancestors`
 *    directive is present. So an app that says who may frame it in its own CSP is left
 *    alone completely, and an app that only sent `X-Frame-Options` gets the matching
 *    `frame-ancestors` - adding `'self'` beside its `DENY` would otherwise loosen it.
 *
 * That merge needs the upstream response, so only the guard's proxy can do it. Where a
 * route is not proxied, the edge falls back to `fallbackFrameHeaders`, which is the
 * part that is safe to set blind.
 */

import { z } from "zod";

/** Most origins one scope may allow. A header is sent on every response. */
export const FRAME_ANCESTORS_MAX = 20;

/** One host: DNS labels, optionally behind a `*.` wildcard (CSP supports exactly that). */
const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * An origin an operator allows to frame a site, in the one form the edge writes, or
 * null.
 *
 * Strict on purpose: the value ends up inside a response header on every request and
 * inside a Traefik file, so anything that could close a directive (`;`), start another
 * source (a space), or quote a keyword is refused rather than escaped. Accepted:
 * `https://example.com`, `https://*.example.com`, `http://intranet.local:8080`. A path
 * is dropped - CSP matches origins here, and keeping `/page` would read as a narrower
 * permission than the browser grants.
 */
export function normalizeFrameOrigin(value: string): string | null {
    const trimmed = value.trim().toLowerCase();
    const match = /^(https?):\/\/([^/?#\s]+)(?:[/?#].*)?$/.exec(trimmed);
    if (!match) return null;
    const [, scheme, authority] = match;
    const port = /^(.*):(\d{1,5})$/.exec(authority!);
    const host = port ? port[1]! : authority!;
    if (host.length > 253 || !HOST.test(host)) return null;
    // A bare `*.com` would hand framing to a whole TLD.
    if (host.startsWith("*.") && !host.slice(2).includes(".")) return null;
    if (port) {
        const number = Number(port[2]);
        if (number < 1 || number > 65_535) return null;
        return `${scheme}://${host}:${number}`;
    }
    return `${scheme}://${host}`;
}

export const frameOriginSchema = z.string().transform((value, ctx) => {
    const origin = normalizeFrameOrigin(value);
    if (!origin) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Use a site address like https://example.com or https://*.example.com"
        });
        return z.NEVER;
    }
    return origin;
});

export const frameAncestorsSchema = z
    .array(frameOriginSchema)
    .max(FRAME_ANCESTORS_MAX, `At most ${FRAME_ANCESTORS_MAX} sites`)
    .transform((list) => [...new Set(list)]);

/** The origins of a list that survive normalising, deduplicated, at most the cap. */
export function cleanFrameAncestors(list: readonly unknown[]): string[] {
    const out = new Set<string>();
    for (const entry of list) {
        if (typeof entry !== "string") continue;
        const origin = normalizeFrameOrigin(entry);
        if (origin) out.add(origin);
        if (out.size >= FRAME_ANCESTORS_MAX) break;
    }
    return [...out];
}

/** The directive the edge adds: this site, plus whatever was allowed. */
export function frameAncestorsDirective(allowed: readonly string[]): string {
    return ["frame-ancestors 'self'", ...allowed].join(" ");
}

/**
 * The headers a route can carry when nothing on the way sees the app's own response
 * (Traefik's headers middleware replaces a header rather than appending to it).
 *
 * Only `X-Frame-Options: SAMEORIGIN`, and only while no extra origin is allowed:
 *  - a `Content-Security-Policy` set there would REPLACE the app's whole policy, so it
 *    is never set blind;
 *  - an app with its own `frame-ancestors` keeps it, because a browser ignores this
 *    header whenever that directive is present;
 *  - `X-Frame-Options` cannot name another site, so with origins allowed it would shut
 *    them out in an older browser. Nothing is sent then rather than the wrong thing.
 */
export function fallbackFrameHeaders(allowed: readonly string[] | undefined): Record<string, string> {
    if (allowed === undefined || allowed.length > 0) return {};
    return { "X-Frame-Options": "SAMEORIGIN" };
}

/** Whether a header map already says who may frame the page, so a rule written blind
 *  on top of it would only fight it. Names are compared case-insensitively. */
export function declaresFraming(headers: Readonly<Record<string, string>>): boolean {
    for (const [name, value] of Object.entries(headers)) {
        const key = name.toLowerCase();
        if (key === "x-frame-options") return true;
        if (key === "content-security-policy" && hasFrameAncestors(value)) return true;
    }
    return false;
}

/** Whether one CSP header value carries a `frame-ancestors` directive. */
function hasFrameAncestors(policy: string): boolean {
    return policy.split(/[;,]/).some((directive) => directive.trim().toLowerCase().startsWith("frame-ancestors"));
}

type NodeHeaders = Record<string, string | string[] | undefined>;

/** Every value of one header in a Node header object (lower-case names). */
function values(headers: NodeHeaders, name: string): string[] {
    const value = headers[name];
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
}

/**
 * The upstream's response headers with framing protection merged in, for the guard's
 * proxy. Header names are Node's lower-case ones. The input is not modified.
 *
 *  - The app's CSP already has `frame-ancestors`: nothing changes. It decided.
 *  - The app sent `X-Frame-Options: DENY` or `SAMEORIGIN`: the matching
 *    `frame-ancestors` (`'none'` or `'self'`) is added so its decision survives the
 *    browser ignoring that header in favour of CSP. Any other value (the dead
 *    `ALLOW-FROM`) is left exactly as sent.
 *  - Otherwise a separate policy with `frame-ancestors 'self' <allowed>` is appended
 *    after the app's own, and `X-Frame-Options: SAMEORIGIN` is set when no extra origin
 *    is allowed.
 */
export function protectFrameHeaders(headers: NodeHeaders, allowed: readonly string[]): NodeHeaders {
    const policies = values(headers, "content-security-policy");
    if (policies.some(hasFrameAncestors)) return headers;
    const out: NodeHeaders = { ...headers };
    const frameOptions = values(headers, "x-frame-options")[0]?.trim().toUpperCase();
    let directive: string;
    if (frameOptions === "DENY") directive = "frame-ancestors 'none'";
    else if (frameOptions === "SAMEORIGIN") directive = "frame-ancestors 'self'";
    else if (frameOptions !== undefined) return headers;
    else {
        directive = frameAncestorsDirective(allowed);
        if (allowed.length === 0) out["x-frame-options"] = "SAMEORIGIN";
    }
    out["content-security-policy"] = [...policies, directive];
    return out;
}
