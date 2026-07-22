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

export const deployVolumeInputSchema = z
    .object({
        applicationId: z.string().uuid(),
        name: z.string().trim().min(1).max(64),
        mountPath: containerMountPath,
        kind: z.enum(DEPLOY_VOLUME_KINDS),
        // A docker volume name (kind=volume) or a subpath (kind=bind|nas). The
        // service normalizes it per kind with normalizeVolumeSource.
        source: z.string().trim().min(1).max(1024),
        // Required for nas, forbidden otherwise (enforced below).
        connectionId: z.string().uuid().optional()
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
