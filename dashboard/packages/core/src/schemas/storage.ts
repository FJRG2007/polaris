/**
 * Storage connection schemas. A connection is split into non-secret `config`
 * (host, port, share path - safe to store in the clear and show in the UI) and
 * `credentials` (passwords, keys, tokens - encrypted at rest, never returned to
 * the client). Both are validated here so the API, the forms, and the driver
 * factory all agree on exactly what each provider needs.
 */

import { z } from "zod";

/** Every storage provider Polaris can drive. */
export const STORAGE_PROVIDER_KINDS = [
    "local",
    "sftp",
    "webdav",
    "s3",
    "smb",
    "nfs",
    "synology",
    "qnap",
    "truenas",
    "unifi-unas"
] as const;

export type StorageProviderKind = (typeof STORAGE_PROVIDER_KINDS)[number];

/** Providers that need the privileged host daemon (kernel mounts / host FS). */
export const HOSTD_REQUIRED_KINDS: readonly StorageProviderKind[] = ["nfs"];

/** Providers that strongly prefer the host daemon but degrade to best-effort. */
export const HOSTD_PREFERRED_KINDS: readonly StorageProviderKind[] = ["smb"];

const hostPort = z.object({
    host: z.string().min(1),
    port: z.number().int().positive().max(65535).optional()
});

// Non-secret configuration, discriminated by provider kind.
export const storageConfigSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("local"), root: z.string().min(1) }),
    z.object({ ...hostPort.shape, kind: z.literal("sftp"), root: z.string().default("/"), username: z.string().min(1) }),
    z.object({ kind: z.literal("webdav"), baseUrl: z.string().url(), username: z.string().optional() }),
    z.object({
        kind: z.literal("s3"),
        endpoint: z.string().url().optional(),
        region: z.string().default("us-east-1"),
        bucket: z.string().min(1),
        forcePathStyle: z.boolean().default(false),
        accessKeyId: z.string().min(1)
    }),
    z.object({ ...hostPort.shape, kind: z.literal("smb"), share: z.string().min(1), domain: z.string().optional(), username: z.string().optional() }),
    z.object({ ...hostPort.shape, kind: z.literal("nfs"), exportPath: z.string().min(1) }),
    z.object({ ...hostPort.shape, kind: z.literal("synology"), secure: z.boolean().default(true), username: z.string().min(1) }),
    z.object({ ...hostPort.shape, kind: z.literal("qnap"), secure: z.boolean().default(true), username: z.string().min(1) }),
    z.object({ ...hostPort.shape, kind: z.literal("truenas"), secure: z.boolean().default(true) }),
    z.object({
        ...hostPort.shape,
        kind: z.literal("unifi-unas"),
        // UniFi OS console over HTTPS (SSH is off by default on the UNAS), so
        // metrics come from the Drive API via the console with UniFi credentials.
        username: z.string().min(1),
        secure: z.boolean().default(true),
        // Optional SMB share on the same device for file browsing. The UNAS
        // usually accepts the same UniFi account for SMB, so only the share name
        // is needed - the username/password above are reused.
        smbShare: z.string().optional()
    })
]);

export type StorageConfig = z.infer<typeof storageConfigSchema>;

// Secret material, discriminated by kind. Optional where the provider allows
// anonymous or key-file access supplied out of band.
export const storageCredentialsSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("local") }),
    z.object({ kind: z.literal("sftp"), password: z.string().optional(), privateKey: z.string().optional(), passphrase: z.string().optional() }),
    z.object({ kind: z.literal("webdav"), password: z.string().optional() }),
    z.object({ kind: z.literal("s3"), secretAccessKey: z.string().min(1) }),
    z.object({ kind: z.literal("smb"), password: z.string().optional() }),
    z.object({ kind: z.literal("nfs") }),
    z.object({ kind: z.literal("synology"), password: z.string().min(1) }),
    z.object({ kind: z.literal("qnap"), password: z.string().min(1) }),
    z.object({ kind: z.literal("truenas"), apiKey: z.string().min(1) }),
    z.object({ kind: z.literal("unifi-unas"), password: z.string().optional(), apiKey: z.string().optional() })
]);

export type StorageCredentials = z.infer<typeof storageCredentialsSchema>;

/** Payload the create-connection form/API accepts (config + credentials + name). */
export const createConnectionSchema = z.object({
    name: z.string().min(1).max(120),
    config: storageConfigSchema,
    credentials: storageCredentialsSchema
});

export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;

/** Whether a provider kind must route through the host daemon to function. */
export function requiresHostd(kind: StorageProviderKind): boolean {
    return HOSTD_REQUIRED_KINDS.includes(kind);
}

/** Whether a provider kind prefers the host daemon but has a degraded fallback. */
export function prefersHostd(kind: StorageProviderKind): boolean {
    return HOSTD_PREFERRED_KINDS.includes(kind);
}

/** Kinds Polaris kernel-mounts under the host mount root (`/mnt/polaris/<id>`),
 *  so a deploy volume can bind onto that path. Other kinds are userspace-only
 *  (no host path to bind). unifi-unas resolves to an SMB mount under the hood. */
export const HOST_MOUNTABLE_KINDS: readonly StorageProviderKind[] = ["nfs", "smb", "unifi-unas"];

/** Whether a connection of this kind exposes a host path a bind mount can target. */
export function canHostMount(kind: StorageProviderKind): boolean {
    return HOST_MOUNTABLE_KINDS.includes(kind);
}
