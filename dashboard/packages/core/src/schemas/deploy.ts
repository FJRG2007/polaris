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
export const WAF_SCOPE_TYPES = ["polaris", "global", "project", "environment", "application"] as const;
export type WafScopeType = (typeof WAF_SCOPE_TYPES)[number];

/** Max entries per list, so one rule can never bloat the generated edge config. */
export const WAF_LIST_MAX = 256;

/** A list of IP/CIDR entries, each validated the same way as a drop-point allowlist. */
const wafCidrList = z.array(cidrOrIp).max(WAF_LIST_MAX, `At most ${WAF_LIST_MAX} entries`);

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
    /** Union of every scope's enabled rule packs. Carried to the edge as ids and
     *  expanded there, so a pack of forty user agents costs four bytes on the wire. */
    readonly presets: readonly string[];
    /** Every scope's custom rules, broadest scope first, evaluated in order. */
    readonly rules: readonly WafCustomRule[];
}
