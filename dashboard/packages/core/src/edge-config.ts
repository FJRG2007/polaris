/**
 * What a service asks of the edge in front of it, beyond "route this hostname here":
 * how hard it may be hit, which response headers every page carries, whether visitors
 * must prove they are a browser first, and which requests are redirected or rewritten
 * on the way in.
 *
 * Stored as one JSON column on the service rather than a table per concern, because it
 * is read whole every time the edge is written and never queried by any one field. That
 * makes the stored value older than the screen by definition - a row saved before a
 * field existed simply lacks it - so every read goes through `parseAppEdgeConfig`,
 * which rebuilds the whole shape and drops what does not validate rather than trusting
 * the outer keys.
 *
 * Everything here ends up inside a Traefik configuration file, and one malformed file
 * in that directory freezes the whole edge on its last good configuration. So the
 * schemas are deliberately narrow: header names are tokens, values are printable ASCII
 * with no quotes that could close a YAML string, paths are absolute, and regular
 * expressions are refused if they use the features Go's engine does not have.
 */

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Hostnames                                                                   */
/* -------------------------------------------------------------------------- */

/** One DNS label: letters, digits and inner dashes, 63 at most. Punycode is letters
 *  and digits already, so an internationalised name passes as its `xn--` form. */
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A hostname as a service's domain stores it: lower case, no trailing dot, at least
 * two labels, and optionally a leading `*.` that makes it a wildcard.
 *
 * Nothing validated this before. The value is written straight into the edge's rule
 * strings, so a stray quote or backtick in a typed domain was a routing file the edge
 * would refuse to load - which, for Traefik's file provider, is every deployed service
 * on the machine left on whatever configuration came before.
 */
export function normalizeDeployHostname(value: string): string | null {
    const trimmed = value.trim().toLowerCase().replace(/\.$/, "");
    if (trimmed.length === 0 || trimmed.length > 253) return null;
    const wildcard = trimmed.startsWith("*.");
    const rest = wildcard ? trimmed.slice(2) : trimmed;
    const labels = rest.split(".");
    // A wildcard needs a real domain under it: `*.com` would claim a whole TLD.
    if (labels.length < (wildcard ? 2 : 1)) return null;
    if (!labels.every((label) => LABEL.test(label))) return null;
    return trimmed;
}

export const deployHostnameSchema = z.string().transform((value, ctx) => {
    const normalized = normalizeDeployHostname(value);
    if (!normalized) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
                "Use a domain like app.example.com, or *.example.com for every subdomain of it."
        });
        return z.NEVER;
    }
    return normalized;
});

/** Whether a stored hostname covers every subdomain of its base (`*.example.com`). */
export function isWildcardHostname(hostname: string): boolean {
    return hostname.startsWith("*.");
}

/**
 * Whether `host` is answered by the stored `hostname`: the same name, or - for a
 * wildcard - exactly one label under its base. One label rather than any depth,
 * because a wildcard certificate covers one label and a deeper name would be served
 * with a certificate the browser refuses.
 */
export function hostnameCovers(hostname: string, host: string): boolean {
    const candidate = host.trim().toLowerCase().replace(/\.$/, "");
    if (!isWildcardHostname(hostname)) return candidate === hostname;
    const base = hostname.slice(2);
    if (!candidate.endsWith(`.${base}`)) return false;
    const label = candidate.slice(0, candidate.length - base.length - 1);
    return LABEL.test(label);
}

/* -------------------------------------------------------------------------- */
/* The stored shape                                                            */
/* -------------------------------------------------------------------------- */

/** How long a rate limit's average is measured over. */
export const EDGE_RATE_PERIODS = ["1s", "1m", "1h"] as const;
export type EdgeRatePeriod = (typeof EDGE_RATE_PERIODS)[number];

/** What a rate limit counts requests by: the connecting address, or a request header
 *  such as an API key - which is how a token-based limit is written. */
export const EDGE_RATE_KEYS = ["ip", "header"] as const;
export type EdgeRateKey = (typeof EDGE_RATE_KEYS)[number];

/** An HTTP header name: RFC 7230 token characters, which is also what keeps it from
 *  breaking out of the configuration it is written into. */
const headerName = z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "Use a header name like X-Api-Key");

/** Printable ASCII with no double quote or backslash - the two characters that could
 *  end the quoted string the value is written into. Header values have no business
 *  carrying either. */
const headerValue = z
    .string()
    .max(2048)
    .regex(
        /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/,
        "Use plain characters, without double quotes or backslashes"
    );

/** An absolute request path prefix. */
const pathPrefix = z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]*$/, "Use a path that starts with /, like /api");

/**
 * A regular expression the edge can run.
 *
 * Traefik is written in Go, whose regular expressions have no lookaround and no
 * backreferences. A pattern using either compiles here and fails there - at which point
 * the edge refuses the whole file - so both are refused up front, with the rest checked
 * by actually compiling it.
 */
const edgeRegex = z
    .string()
    .min(1)
    .max(512)
    .regex(/^[\x20-\x21\x23-\x7e]*$/, "Use plain characters, without double quotes")
    .refine(
        (value) => !/\(\?<?[=!]/.test(value),
        "Lookahead and lookbehind are not supported at the edge"
    )
    .refine((value) => !/\\[1-9]/.test(value), "Backreferences are not supported at the edge")
    .refine((value) => {
        try {
            new RegExp(value);
            return true;
        } catch {
            return false;
        }
    }, "That is not a valid regular expression");

/** A replacement for a regular-expression redirect or rewrite. Groups are written
 *  `${1}`, which is Go's syntax and the one Traefik reads. */
const edgeReplacement = z
    .string()
    .min(1)
    .max(512)
    .regex(
        /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/,
        "Use plain characters, without double quotes or backslashes"
    );

export const EDGE_RATE_LIMITS_MAX = 8;
export const EDGE_REDIRECTS_MAX = 8;
export const EDGE_REWRITES_MAX = 8;
export const EDGE_CUSTOM_HEADERS_MAX = 16;

export const edgeRateLimitSchema = z
    .object({
        /** Only requests under this path; absent limits the whole service. */
        path: pathPrefix.optional(),
        /** Requests allowed per period, on average. */
        average: z.number().int().min(1).max(1_000_000),
        period: z.enum(EDGE_RATE_PERIODS).default("1s"),
        /** How many requests above the average a short burst may take. */
        burst: z.number().int().min(1).max(1_000_000),
        key: z.enum(EDGE_RATE_KEYS).default("ip"),
        /** The header counted by when `key` is "header". */
        header: headerName.optional()
    })
    .superRefine((value, ctx) => {
        if (value.key === "header" && !value.header) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["header"],
                message: "Name the header to count requests by"
            });
        }
    });
export type EdgeRateLimit = z.infer<typeof edgeRateLimitSchema>;

export const EDGE_HEADER_PRESETS = ["off", "recommended", "strict"] as const;
export type EdgeHeaderPreset = (typeof EDGE_HEADER_PRESETS)[number];

/**
 * The security headers, as a preset plus the values that differ from it.
 *
 * An override of "" means "do not send this one", which is the only way to switch a
 * single header off without dropping the rest of the preset - the header a strict CSP
 * breaks is usually one, and the answer is to relax that one.
 */
export const edgeHeadersSchema = z.object({
    preset: z.enum(EDGE_HEADER_PRESETS).default("off"),
    hstsMaxAge: z.number().int().min(0).max(63_072_000).optional(),
    hstsIncludeSubdomains: z.boolean().optional(),
    hstsPreload: z.boolean().optional(),
    contentSecurityPolicy: headerValue.optional(),
    frameOptions: z.enum(["", "DENY", "SAMEORIGIN"]).optional(),
    referrerPolicy: z
        .enum([
            "",
            "no-referrer",
            "no-referrer-when-downgrade",
            "origin",
            "origin-when-cross-origin",
            "same-origin",
            "strict-origin",
            "strict-origin-when-cross-origin",
            "unsafe-url"
        ])
        .optional(),
    permissionsPolicy: headerValue.optional(),
    crossOriginOpenerPolicy: z
        .enum(["", "unsafe-none", "same-origin-allow-popups", "same-origin"])
        .optional(),
    crossOriginEmbedderPolicy: z
        .enum(["", "unsafe-none", "require-corp", "credentialless"])
        .optional(),
    crossOriginResourcePolicy: z.enum(["", "same-site", "same-origin", "cross-origin"]).optional(),
    contentTypeNosniff: z.boolean().optional(),
    custom: z
        .array(z.object({ name: headerName, value: headerValue }))
        .max(EDGE_CUSTOM_HEADERS_MAX)
        .default([])
});
export type EdgeHeaders = z.infer<typeof edgeHeadersSchema>;

export const EDGE_REDIRECT_KINDS = ["www-to-apex", "apex-to-www", "regex"] as const;
export type EdgeRedirectKind = (typeof EDGE_REDIRECT_KINDS)[number];

export const edgeRedirectSchema = z
    .object({
        kind: z.enum(EDGE_REDIRECT_KINDS),
        /** Matched against the whole URL, scheme and host included. */
        regex: edgeRegex.optional(),
        replacement: edgeReplacement.optional(),
        permanent: z.boolean().default(true)
    })
    .superRefine((value, ctx) => {
        if (value.kind === "regex" && (!value.regex || !value.replacement)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["regex"],
                message: "A pattern redirect needs both the pattern and where it goes"
            });
        }
    });
export type EdgeRedirect = z.infer<typeof edgeRedirectSchema>;

export const EDGE_REWRITE_KINDS = ["strip-prefix", "add-prefix", "replace-path"] as const;
export type EdgeRewriteKind = (typeof EDGE_REWRITE_KINDS)[number];

export const edgeRewriteSchema = z
    .object({
        kind: z.enum(EDGE_REWRITE_KINDS),
        prefix: pathPrefix.optional(),
        regex: edgeRegex.optional(),
        replacement: edgeReplacement.optional()
    })
    .superRefine((value, ctx) => {
        if ((value.kind === "strip-prefix" || value.kind === "add-prefix") && !value.prefix) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["prefix"],
                message: "Name the path prefix"
            });
        }
        if (value.kind === "replace-path" && (!value.regex || !value.replacement)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["regex"],
                message: "A path rewrite needs both the pattern and its replacement"
            });
        }
    });
export type EdgeRewrite = z.infer<typeof edgeRewriteSchema>;

/**
 * Whether visitors are asked to prove they are running a browser before they are let
 * through: never, always, or only while the service is being flooded.
 */
export const EDGE_CHALLENGE_MODES = ["off", "on", "auto"] as const;
export type EdgeChallengeMode = (typeof EDGE_CHALLENGE_MODES)[number];

/** Who a concurrency cap counts: each visitor separately, or the service as a whole. */
export const EDGE_CONCURRENCY_SCOPES = ["client", "service"] as const;
export type EdgeConcurrencyScope = (typeof EDGE_CONCURRENCY_SCOPES)[number];

/**
 * How the edge spreads a service's traffic over its replicas. Only means anything
 * with more than one: `sticky` keeps each visitor on the replica that answered them
 * first - what a WebSocket or an in-memory session needs - and `healthPath` is asked
 * every few seconds so a replica that stops answering it is left out until it does.
 */
export const edgeBalancingSchema = z.object({
    sticky: z.boolean().default(false),
    healthPath: z
        .string()
        .trim()
        .max(200)
        .regex(/^\/[^\s"\\]*$/, "Start the path with / and leave out spaces and quotes")
        .nullable()
        .default(null)
});
export type EdgeBalancing = z.infer<typeof edgeBalancingSchema>;

/**
 * A share of a service's traffic sent to one of its kept releases rather than the
 * current one - a canary. Each visitor stays on whichever version first answered
 * them. At most half: past that the canary is the release, and promoting it is the
 * honest way to say so.
 */
export const edgeCanarySchema = z.object({
    deploymentId: z.string().uuid(),
    percent: z.number().int().min(1).max(50)
});
export type EdgeCanary = z.infer<typeof edgeCanarySchema>;

export const appEdgeConfigSchema = z.object({
    rateLimits: z.array(edgeRateLimitSchema).max(EDGE_RATE_LIMITS_MAX).default([]),
    /** Requests in flight at once; 0 is no cap. */
    concurrency: z.number().int().min(0).max(100_000).default(0),
    concurrencyScope: z.enum(EDGE_CONCURRENCY_SCOPES).default("client"),
    challenge: z.enum(EDGE_CHALLENGE_MODES).default("off"),
    headers: edgeHeadersSchema.default({ preset: "off", custom: [] }),
    redirects: z.array(edgeRedirectSchema).max(EDGE_REDIRECTS_MAX).default([]),
    rewrites: z.array(edgeRewriteSchema).max(EDGE_REWRITES_MAX).default([]),
    balancing: edgeBalancingSchema.default({ sticky: false, healthPath: null }),
    canary: edgeCanarySchema.nullable().default(null)
});
export type AppEdgeConfig = z.infer<typeof appEdgeConfigSchema>;

/** What a service asks of the edge when it has asked for nothing. */
export const EMPTY_EDGE_CONFIG: AppEdgeConfig = appEdgeConfigSchema.parse({});

/**
 * The stored column, read whole.
 *
 * Every list is filtered entry by entry rather than rejected as a unit: one entry that
 * no longer validates (a rule written by an older version, a pattern a newer check
 * refuses) must cost that entry, not every other protection on the service. A value
 * that is not JSON at all reads as the empty config, never as an error.
 */
export function parseAppEdgeConfig(raw: string | null | undefined): AppEdgeConfig {
    if (!raw) return EMPTY_EDGE_CONFIG;
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return EMPTY_EDGE_CONFIG;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY_EDGE_CONFIG;
    const obj = value as Record<string, unknown>;
    const each = <T>(
        list: unknown,
        schema: z.ZodType<T, z.ZodTypeDef, unknown>,
        max: number
    ): T[] =>
        (Array.isArray(list) ? list : [])
            .map((entry) => schema.safeParse(entry))
            .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
            .slice(0, max);
    const headers = edgeHeadersSchema.safeParse(obj.headers ?? {});
    const concurrency = z.number().int().min(0).max(100_000).safeParse(obj.concurrency);
    const scope = z.enum(EDGE_CONCURRENCY_SCOPES).safeParse(obj.concurrencyScope);
    const challenge = z.enum(EDGE_CHALLENGE_MODES).safeParse(obj.challenge);
    const balancing = edgeBalancingSchema.safeParse(obj.balancing ?? {});
    const canary = edgeCanarySchema.safeParse(obj.canary);
    return {
        rateLimits: each(obj.rateLimits, edgeRateLimitSchema, EDGE_RATE_LIMITS_MAX),
        concurrency: concurrency.success ? concurrency.data : 0,
        concurrencyScope: scope.success ? scope.data : "client",
        challenge: challenge.success ? challenge.data : "off",
        headers: headers.success ? headers.data : EMPTY_EDGE_CONFIG.headers,
        redirects: each(obj.redirects, edgeRedirectSchema, EDGE_REDIRECTS_MAX),
        rewrites: each(obj.rewrites, edgeRewriteSchema, EDGE_REWRITES_MAX),
        balancing: balancing.success ? balancing.data : EMPTY_EDGE_CONFIG.balancing,
        canary: canary.success ? canary.data : null
    };
}

/** Whether a config asks the edge for anything at all - the common case is not. */
export function edgeConfigIsEmpty(config: AppEdgeConfig): boolean {
    return (
        config.rateLimits.length === 0 &&
        config.concurrency === 0 &&
        config.challenge === "off" &&
        Object.keys(securityHeaderMap(config.headers)).length === 0 &&
        config.redirects.length === 0 &&
        config.rewrites.length === 0
    );
}

/* -------------------------------------------------------------------------- */
/* Security headers                                                            */
/* -------------------------------------------------------------------------- */

interface PresetValues {
    readonly hstsMaxAge: number;
    readonly hstsIncludeSubdomains: boolean;
    readonly hstsPreload: boolean;
    readonly contentSecurityPolicy: string;
    readonly frameOptions: string;
    readonly referrerPolicy: string;
    readonly permissionsPolicy: string;
    readonly crossOriginOpenerPolicy: string;
    readonly crossOriginEmbedderPolicy: string;
    readonly crossOriginResourcePolicy: string;
    readonly contentTypeNosniff: boolean;
}

/**
 * The two presets.
 *
 * "Recommended" is what can go in front of any app without breaking it: HSTS, no
 * sniffing, a sane referrer, and framing only by the same site. No CSP, because a CSP
 * that does not know the app is a blank page, and a popup-friendly COOP, because
 * sign-in with Google and every payment window is a popup.
 *
 * "Strict" is the full isolation set - the headers a site needs for cross-origin
 * isolation (COOP same-origin plus COEP require-corp) and a CSP that only trusts the
 * site itself. It is meant to be chosen for an app that is known to survive it.
 */
const PRESETS: Readonly<Record<Exclude<EdgeHeaderPreset, "off">, PresetValues>> = {
    recommended: {
        hstsMaxAge: 15_552_000,
        hstsIncludeSubdomains: false,
        hstsPreload: false,
        contentSecurityPolicy: "",
        frameOptions: "SAMEORIGIN",
        referrerPolicy: "strict-origin-when-cross-origin",
        permissionsPolicy: "",
        crossOriginOpenerPolicy: "same-origin-allow-popups",
        crossOriginEmbedderPolicy: "",
        crossOriginResourcePolicy: "",
        contentTypeNosniff: true
    },
    strict: {
        hstsMaxAge: 63_072_000,
        hstsIncludeSubdomains: true,
        hstsPreload: true,
        contentSecurityPolicy:
            "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
        frameOptions: "DENY",
        referrerPolicy: "no-referrer",
        permissionsPolicy: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        crossOriginOpenerPolicy: "same-origin",
        crossOriginEmbedderPolicy: "require-corp",
        crossOriginResourcePolicy: "same-origin",
        contentTypeNosniff: true
    }
};

const NONE: PresetValues = {
    hstsMaxAge: 0,
    hstsIncludeSubdomains: false,
    hstsPreload: false,
    contentSecurityPolicy: "",
    frameOptions: "",
    referrerPolicy: "",
    permissionsPolicy: "",
    crossOriginOpenerPolicy: "",
    crossOriginEmbedderPolicy: "",
    crossOriginResourcePolicy: "",
    contentTypeNosniff: false
};

/**
 * The response headers a config puts on every answer, as exact names and values.
 *
 * One flat map, used by both edges: the local file writes it as a headers middleware
 * and a remote server's container labels write the same map, so what a visitor
 * receives does not depend on which edge served them.
 */
export function securityHeaderMap(headers: EdgeHeaders): Record<string, string> {
    const base = headers.preset === "off" ? NONE : PRESETS[headers.preset];
    const pick = <K extends keyof PresetValues>(key: K): PresetValues[K] =>
        (headers[key] as PresetValues[K] | undefined) ?? base[key];
    const out: Record<string, string> = {};
    const maxAge = pick("hstsMaxAge");
    if (maxAge > 0) {
        out["Strict-Transport-Security"] = [
            `max-age=${maxAge}`,
            ...(pick("hstsIncludeSubdomains") ? ["includeSubDomains"] : []),
            ...(pick("hstsPreload") ? ["preload"] : [])
        ].join("; ");
    }
    const csp = pick("contentSecurityPolicy");
    if (csp) out["Content-Security-Policy"] = csp;
    const frame = pick("frameOptions");
    if (frame) out["X-Frame-Options"] = frame;
    const referrer = pick("referrerPolicy");
    if (referrer) out["Referrer-Policy"] = referrer;
    const permissions = pick("permissionsPolicy");
    if (permissions) out["Permissions-Policy"] = permissions;
    const coop = pick("crossOriginOpenerPolicy");
    if (coop) out["Cross-Origin-Opener-Policy"] = coop;
    const coep = pick("crossOriginEmbedderPolicy");
    if (coep) out["Cross-Origin-Embedder-Policy"] = coep;
    const corp = pick("crossOriginResourcePolicy");
    if (corp) out["Cross-Origin-Resource-Policy"] = corp;
    if (pick("contentTypeNosniff")) out["X-Content-Type-Options"] = "nosniff";
    // Last, so a custom header can replace one the preset set - which is how somebody
    // who needs one exact CSP writes it without abandoning the rest of the preset.
    for (const entry of headers.custom) out[entry.name] = entry.value;
    return out;
}

/* -------------------------------------------------------------------------- */
/* Flood detection, for the automatic challenge                               */
/* -------------------------------------------------------------------------- */

/** The part of an access-log entry the flood check reads. Structural, like the jails,
 *  because the parser lives in @polaris/deploy and core does not depend on it. */
export interface FloodLogEntry {
    readonly time: string | null;
    readonly host?: string | null;
}

export interface FloodOptions {
    /** Requests a host must take in the last minute before it can count as flooded at
     *  all. Below this there is no attack a challenge would be worth putting up for. */
    readonly minPerMinute?: number;
    /** How many times its own usual minute the last minute has to be. */
    readonly overBaseline?: number;
}

const FLOOD_DEFAULTS: Required<FloodOptions> = { minPerMinute: 600, overBaseline: 10 };

/**
 * The hosts whose last minute of traffic is far above their own usual minute.
 *
 * Judged per host against itself rather than against a fixed number, because a
 * service's ordinary traffic is the only thing that says what an attack on it looks
 * like: six hundred requests a minute is a quiet afternoon for an API and an attack on
 * a blog. The baseline is the median of the earlier minutes in the window, so one
 * previous spike does not raise the bar. A host with no earlier traffic at all is
 * judged on the minimum alone.
 */
export function detectFloodedHosts(
    entries: readonly FloodLogEntry[],
    now: number,
    windowMinutes: number,
    options: FloodOptions = {}
): string[] {
    const config = { ...FLOOD_DEFAULTS, ...options };
    const from = now - windowMinutes * 60_000;
    const perHost = new Map<string, number[]>();
    for (const entry of entries) {
        if (!entry.host || !entry.time) continue;
        const at = Date.parse(entry.time);
        if (!Number.isFinite(at) || at < from || at > now) continue;
        const host = entry.host.toLowerCase().replace(/:\d+$/, "");
        let buckets = perHost.get(host);
        if (!buckets) {
            buckets = new Array<number>(windowMinutes).fill(0);
            perHost.set(host, buckets);
        }
        // The last bucket is exactly the last minute, because the window is a whole
        // number of minutes ending now.
        const index = Math.min(windowMinutes - 1, Math.floor((at - from) / 60_000));
        buckets[index] = (buckets[index] ?? 0) + 1;
    }
    const flooded: string[] = [];
    for (const [host, buckets] of perHost) {
        const last = buckets[buckets.length - 1] ?? 0;
        if (last < config.minPerMinute) continue;
        const earlier = buckets.slice(0, -1).sort((a, b) => a - b);
        const median = earlier.length > 0 ? (earlier[Math.floor(earlier.length / 2)] ?? 0) : 0;
        if (median === 0 || last >= median * config.overBaseline) flooded.push(host);
    }
    return flooded.sort();
}
