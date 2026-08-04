/**
 * Deploy volume schema. A volume attaches a persistent path to a service. Three
 * kinds, all confined - never an arbitrary host path:
 *   - volume: a named docker volume.
 *   - bind:   a subpath under the host volume root.
 *   - nas:    a subpath under a storage connection's host mount (the connection id
 *             is prefixed onto the source when the deploy plan is built).
 * The daemon re-validates and confines every source, so this is the first gate,
 * not the only one.
 */

import { z } from "zod";
import { cidrOrIp } from "./file-request.js";
import { normalizeRelPath, UnsafePathError } from "../paths.js";

export const DEPLOY_VOLUME_KINDS = ["volume", "bind", "nas"] as const;
export type DeployVolumeKind = (typeof DEPLOY_VOLUME_KINDS)[number];

/** True if the string contains a C0 control character. */
function hasControlChar(value: string): boolean {
    for (let i = 0; i < value.length; i += 1) {
        if (value.charCodeAt(i) < 0x20) return true;
    }
    return false;
}

/** An absolute POSIX container path with no control chars, e.g. "/app/secrets". */
const containerMountPath = z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .refine((path) => path.startsWith("/"), "Mount path must be absolute (start with /)")
    .refine((path) => !hasControlChar(path), "Mount path must not contain control characters");

/** A human-readable size cap like "10G", "500M", "1.5T". */
const SIZE_LIMIT_RE = /^\d+(\.\d+)?\s*(K|M|G|T)i?B?$/i;

export const deployVolumeInputSchema = z
    .object({
        applicationId: z.string().uuid(),
        name: z.string().trim().min(1).max(64),
        mountPath: containerMountPath,
        kind: z.enum(DEPLOY_VOLUME_KINDS),
        // A docker volume name (kind=volume) or an explicit subpath (kind=bind|nas)
        // the user typed or picked. Omit for bind/nas to let the service generate a
        // structured path under polaris/deploy/<project>/<app>/<name>.
        source: z.string().trim().min(1).max(1024).optional(),
        // Required for nas, forbidden otherwise (enforced below).
        connectionId: z.string().uuid().optional(),
        // Optional size cap, human-readable like "10G", "500M", "1.5T".
        sizeLimit: z
            .string()
            .trim()
            .regex(SIZE_LIMIT_RE, "Use a size like 10G, 500M, or 1.5T")
            .optional()
            .or(z.literal("").transform(() => undefined))
    })
    .superRefine((value, ctx) => {
        if (value.kind === "nas" && !value.connectionId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["connectionId"],
                message: "A storage connection is required for NAS volumes"
            });
        }
        if (value.kind !== "nas" && value.connectionId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["connectionId"],
                message: "Only NAS volumes use a storage connection"
            });
        }
    });

export type DeployVolumeInput = z.infer<typeof deployVolumeInputSchema>;

/** Patch for an existing volume. Only provided fields change; `kind` is fixed at
 *  create. An empty-string sizeLimit clears the cap; omitting it leaves it. */
export const deployVolumeUpdateSchema = z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(64).optional(),
    mountPath: containerMountPath.optional(),
    source: z.string().trim().min(1).max(1024).optional(),
    connectionId: z.string().uuid().optional(),
    sizeLimit: z
        .union([z.string().trim().regex(SIZE_LIMIT_RE, "Use a size like 10G, 500M, or 1.5T"), z.literal("")])
        .optional()
});

export type DeployVolumeUpdateInput = z.infer<typeof deployVolumeUpdateSchema>;

/** A docker named-volume name: alphanumeric plus `_.-`, starting alphanumeric. */
const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Normalize a volume `source` for its kind, returning the value to persist, or
 * throwing on anything unsafe. Named volumes are charset-checked; bind and nas
 * sources are reduced to a safe, root-relative subpath (no traversal, no leading
 * slash, no control chars) via normalizeRelPath.
 */
export function normalizeVolumeSource(kind: DeployVolumeKind, source: string): string {
    if (kind === "volume") {
        if (!VOLUME_NAME.test(source)) throw new UnsafePathError(source);
        return source;
    }
    const rel = normalizeRelPath(source);
    if (!rel) throw new UnsafePathError(source);
    return rel;
}

/**
 * WAF (Web Application Firewall) rules for a Deploy scope. A rule can restrict
 * ingress to an IP allowlist, deny an IP denylist, and/or require a Polaris login.
 * Rules exist at four scopes and are merged nearest-scope-wins by the service
 * layer; each server's edge (Traefik) enforces the merged result, so the controls
 * keep working when the Polaris control plane is down.
 */
/**
 * `polaris` is the dashboard's own ingress rather than a deployed service: it is not
 * part of any project and never takes part in a service's merge, so blocking the
 * public internet there cannot reach an app, and blocking an app cannot reach it.
 */
export const WAF_SCOPE_TYPES = [
    "polaris",
    "global",
    "server-group",
    "server",
    "project",
    "environment",
    "application"
] as const;
export type WafScopeType = (typeof WAF_SCOPE_TYPES)[number];

/**
 * Scopes ranked broadest first, which is the order their rules are offered a request.
 * A rule set is first-match-wins, so this ranking is what stops a project writing an
 * `allow` that overrides an instance-wide block.
 *
 * Where a server sits relative to a project is a genuine choice rather than a fact:
 * the two are orthogonal (a project's services can be spread across servers, and a
 * server hosts services from several projects). Server comes first because it is a
 * statement about the machine - "nothing reaches this box except from the office" is
 * meant to hold whatever happens to be deployed on it.
 */
export const WAF_SCOPE_ORDER: Readonly<Record<WafScopeType, number>> = {
    polaris: 0,
    global: 0,
    "server-group": 1,
    server: 2,
    project: 3,
    environment: 4,
    application: 5
};

/** Max entries per list, so one rule can never bloat the generated edge config. */
export const WAF_LIST_MAX = 256;

/** A list of IP/CIDR entries, each validated the same way as a drop-point allowlist. */
const wafCidrList = z.array(cidrOrIp).max(WAF_LIST_MAX, `At most ${WAF_LIST_MAX} entries`);

/** The kinds of principal a require-login rule can name. The same three a policy
 *  attaches to, so "who" means one thing across the instance. */
export const WAF_PRINCIPAL_TYPES = ["user", "group", "role"] as const;
export type WafPrincipalType = (typeof WAF_PRINCIPAL_TYPES)[number];

/**
 * One named principal, written as `<type>:<id>`.
 *
 * A single string rather than a pair of fields because it is stored, merged,
 * deduplicated and compared as one value: it dedupes with `Set` and matches with one
 * comparison, where a type and an id would have to be flattened into this anyway.
 */
export const wafPrincipalRef = z
    .string()
    .trim()
    .max(80)
    .regex(new RegExp(`^(${WAF_PRINCIPAL_TYPES.join("|")}):[0-9a-zA-Z_-]{1,64}$`), "Not a valid principal");

/**
 * A moment a grant starts or stops applying, in unix seconds.
 *
 * Seconds rather than an ISO string because the edge compares this against its own
 * clock on every request, and the same number is what travels in the rule header, is
 * stored, and is merged - one representation end to end, and no date parsing in the
 * hot path. The UI converts to and from a local datetime on the way in and out.
 */
const wafGrantMoment = z.number().int().min(0).max(4102444800);

/**
 * One principal a login rule names, with the window the entry applies in.
 *
 * Both bounds are optional and independent: `from` alone is access that begins later,
 * `until` alone is access that lapses, both is a booked window, neither - the common
 * case - is an entry that simply applies. The window is evaluated at the edge on every
 * request rather than baked into anything, so a grant that lapses stops working then
 * and not whenever a token happens to expire.
 */
export const wafPrincipalGrantSchema = z
    .object({
        ref: wafPrincipalRef,
        /** Inclusive. Before it, the entry is not there yet. */
        from: wafGrantMoment.optional(),
        /** Exclusive. From it on, the entry is spent. */
        until: wafGrantMoment.optional()
    })
    .refine((grant) => grant.from === undefined || grant.until === undefined || grant.from < grant.until, {
        message: "The start must come before the expiry",
        path: ["until"]
    });

export type WafPrincipalGrant = z.infer<typeof wafPrincipalGrantSchema>;

/** The principals one scope names, capped like every other list on a rule. */
const wafPrincipalList = z.array(wafPrincipalGrantSchema).max(WAF_LIST_MAX, `At most ${WAF_LIST_MAX} entries`);

/**
 * What a custom rule can look at. Every one of these is a fact the edge already
 * forwards to the guard, so a rule never needs a lookup to decide - which is what
 * lets the whole set travel in the route's own config and keep enforcing while
 * Polaris is down.
 */
export const WAF_RULE_FIELDS = ["ip", "host", "path", "method", "user_agent", "query"] as const;
export type WafRuleField = (typeof WAF_RULE_FIELDS)[number];

/** How a field is compared against the values. `ip` accepts an address or a CIDR
 *  range and ignores the string operators. */
export const WAF_RULE_OPERATORS = [
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "starts_with",
    "not_starts_with",
    "ends_with",
    "not_ends_with"
] as const;
export type WafRuleOperator = (typeof WAF_RULE_OPERATORS)[number];

/** What happens to a request the rule matches. `allow` stops evaluation and admits
 *  it, so a narrow exception can sit above a broad block. */
export const WAF_RULE_ACTIONS = ["block", "allow"] as const;
export type WafRuleAction = (typeof WAF_RULE_ACTIONS)[number];

/** Caps, so the rule set stays something the edge carries in a header. */
export const WAF_RULES_MAX = 32;
const CONDITIONS_MAX = 8;
const VALUES_MAX = 64;

export const wafConditionSchema = z.object({
    field: z.enum(WAF_RULE_FIELDS),
    operator: z.enum(WAF_RULE_OPERATORS),
    /** Matched as an OR: any value satisfying the operator satisfies the condition.
     *  A negative operator is the inverse - none of them may match. */
    values: z.array(z.string().trim().min(1).max(512)).min(1).max(VALUES_MAX)
});

export type WafCondition = z.infer<typeof wafConditionSchema>;

export const wafCustomRuleSchema = z.object({
    /** Names the rule in the list and in the block reason; not an identifier. */
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    action: z.enum(WAF_RULE_ACTIONS),
    /** All must match, so a rule reads as one sentence with "and" in it. */
    conditions: z.array(wafConditionSchema).min(1).max(CONDITIONS_MAX)
});

export type WafCustomRule = z.infer<typeof wafCustomRuleSchema>;

/** Managed rule packs enabled on a scope, stored as ids (see waf-presets.ts). Not
 *  an enum: an id retired in a later release must still parse, so the reader can
 *  drop it rather than fail the whole rule. */
const wafPresetList = z.array(z.string().trim().min(1).max(64)).max(32);

export const wafRuleInputSchema = z
    .object({
        ipAllowlist: wafCidrList.default([]),
        ipDenylist: wafCidrList.default([]),
        requireLogin: z.boolean().default(false),
        /**
         * Who the login admits, as `user:`/`group:`/`role:` refs.
         *
         * Empty means every account on the instance, which is what `requireLogin` alone
         * has always meant - so an existing rule keeps behaving exactly as it did, and
         * "signed in" stays the answer until somebody narrows it. A non-empty list is
         * read as an allowlist: only a visitor resolving to one of these gets in.
         *
         * Kept independent of `requireLogin` rather than nested under it, so turning the
         * login off and back on does not lose the list somebody wrote.
         */
        loginAllowPrincipals: wafPrincipalList.default([]),
        /**
         * Who the login refuses, whatever else admits them.
         *
         * Checked before the allowlist and never overridden by it, the way the address
         * denylist sits above the address allowlist: an account named here is out even
         * if a group it belongs to is admitted, which is what makes "everyone in
         * Engineering except this contractor" expressible in one rule. Unions across
         * scopes for the same reason a refusal always does - a narrower scope must not
         * be able to re-admit whoever a broader one shut out.
         */
        loginDenyPrincipals: wafPrincipalList.default([]),
        /**
         * Refuse requests whose headers do not hold together as a browser's.
         *
         * Off by default, unlike the rule packs, and deliberately: it is a heuristic
         * over what a client sent rather than a statement about what it asked for, and
         * plenty of legitimate non-browser traffic - a CLI, a health check, a webhook -
         * looks exactly like the thing it refuses. Armed by an operator who knows the
         * scope serves browsers.
         */
        browserIntegrity: z.boolean().default(false),
        /**
         * Refuse a request whose own URL carries a SQL injection payload.
         *
         * On by default, unlike the integrity check above, because it is not a
         * heuristic about the client: every signature it matches is a string that
         * cannot occur in an honest request line (see waf-injection.ts). It combines
         * across scopes the way email obfuscation does rather than the way the other
         * refusals do - see `sqlInjectionProtection` in ResolvedWaf.
         */
        sqlInjectionProtection: z.boolean().default(true),
        /**
         * Refuse a request whose own URL carries a cross-site scripting payload.
         *
         * Its own control rather than half of the one above: the two are armed and
         * switched off for different reasons, and a scope that has to allow SQL-ish
         * text in a query string has no reason to also stop refusing script tags.
         * Defaults and scope combination match the SQL check exactly.
         */
        xssProtection: z.boolean().default(true),
        /**
         * Rewrite email addresses in served HTML so a harvester reading the source
         * finds an encoded token instead. On everywhere unless something switches it
         * off (see `emailObfuscation` in ResolvedWaf for how the scopes combine).
         */
        emailObfuscation: z.boolean().default(true),
        presets: wafPresetList.default([]),
        rules: z.array(wafCustomRuleSchema).max(WAF_RULES_MAX).default([])
    })
    .superRefine((value, ctx) => {
        // A best-effort UX guard against contradictory rules (exact-string match, so
        // "10.0.0.1" vs "10.0.0.1/32" is not caught) - the edge resolves allow before
        // deny regardless, so this never widens access, it only warns the operator.
        const deny = new Set(value.ipDenylist);
        const overlap = value.ipAllowlist.find((entry) => deny.has(entry));
        if (overlap) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["ipDenylist"],
                message: `"${overlap}" is in both the allow and deny lists`
            });
        }
        // Same warning for the people lists, and for the same reason: deny wins at the
        // edge either way, so naming somebody twice is an operator contradicting
        // themselves rather than something that can widen access.
        const deniedPrincipals = new Set(value.loginDenyPrincipals.map((grant) => grant.ref));
        const namedTwice = value.loginAllowPrincipals.find((grant) => deniedPrincipals.has(grant.ref));
        if (namedTwice) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["loginDenyPrincipals"],
                message: `"${namedTwice.ref}" is both admitted and refused`
            });
        }
    });

export type WafRuleInput = z.infer<typeof wafRuleInputSchema>;

/** The merged WAF decision for one application, ready to materialize into the edge. */
export interface ResolvedWaf {
    /** One non-empty IP allowlist per scope that defines one. A request must satisfy
     *  every list, so each becomes a chained Traefik `ipAllowList` middleware (they
     *  AND): a child scope can only narrow a parent's allowlist, never widen it. */
    readonly allowLists: readonly (readonly string[])[];
    /** Union of every scope's denylist; a request is blocked if it matches any entry. */
    readonly deny: readonly string[];
    /** True if any scope requires a Polaris login. */
    readonly requireLogin: boolean;
    /**
     * One non-empty principal list per scope that admits anybody. A visitor must satisfy
     * every list, exactly as they must satisfy every IP allowlist above: a child scope
     * can narrow who its parent admitted and never widen it. A scope that names nobody
     * contributes no list, so it constrains nothing - which is why the common case
     * (login required, nobody named anywhere) stays "any account".
     */
    readonly loginAllowLists: readonly (readonly WafPrincipalGrant[])[];
    /** Union of every scope's refused principals, flattened for the same reason the
     *  address denylist is: a refusal applies wherever it was written, so which scope
     *  wrote it changes nothing about who it stops. */
    readonly loginDeny: readonly WafPrincipalGrant[];
    /** True if any scope arms the browser integrity check. Unions like requireLogin:
     *  it refuses traffic, so a narrower scope must not be able to switch off a
     *  broader one's decision to refuse it. */
    readonly browserIntegrity: boolean;
    /**
     * True only if EVERY scope leaves SQL injection protection on.
     *
     * It refuses traffic, so unioning is the shape the rest of this file argues for -
     * and it is on by default, which is what changes the answer. A default that unions
     * is a default nothing can ever get out of: an operator whose one legacy service
     * really does put SQL in a query string would have no way to say so, because the
     * instance-wide scope they inherit it from covers every other service too. So any
     * scope can switch it off for what that scope covers, and a narrower one cannot
     * switch it back on. Exempting a single URL rather than a whole scope is what the
     * custom `allow` rules above it are for.
     */
    readonly sqlInjectionProtection: boolean;
    /** True only if EVERY scope leaves XSS protection on. Resolved separately from the
     *  SQL check and for the same reasons - the scope that has to allow one of them
     *  rarely has to allow the other. */
    readonly xssProtection: boolean;
    /**
     * True only if EVERY scope leaves email obfuscation on.
     *
     * The one control here that intersects rather than unions, because it is the one
     * that is not a refusal: it rewrites the page, so getting it wrong breaks a
     * working site rather than exposing one. Any scope can therefore switch it off for
     * what that scope covers, and a narrower scope cannot switch it back on - which is
     * also what lets it default on everywhere without becoming impossible to escape.
     */
    readonly emailObfuscation: boolean;
    /** Union of every scope's enabled rule packs. Carried to the edge as ids and
     *  expanded there, so a pack of forty user agents costs four bytes on the wire. */
    readonly presets: readonly string[];
    /** Every scope's custom rules, broadest scope first, evaluated in order. */
    readonly rules: readonly WafCustomRule[];
}
