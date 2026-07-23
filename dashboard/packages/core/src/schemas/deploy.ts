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
import { normalizeRelPath, UnsafePathError } from "../paths.js";
import { cidrOrIp } from "./file-request.js";

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
export const WAF_SCOPE_TYPES = ["global", "project", "environment", "application"] as const;
export type WafScopeType = (typeof WAF_SCOPE_TYPES)[number];

/** Max entries per list, so one rule can never bloat the generated edge config. */
export const WAF_LIST_MAX = 256;

/** A list of IP/CIDR entries, each validated the same way as a drop-point allowlist. */
const wafCidrList = z.array(cidrOrIp).max(WAF_LIST_MAX, `At most ${WAF_LIST_MAX} entries`);

export const wafRuleInputSchema = z
    .object({
        ipAllowlist: wafCidrList.default([]),
        ipDenylist: wafCidrList.default([]),
        requireLogin: z.boolean().default(false)
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
}
