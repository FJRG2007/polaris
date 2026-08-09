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
    "unifi-unas",
    "gdrive",
    "onedrive",
    "dropbox"
] as const;

export type StorageProviderKind = (typeof STORAGE_PROVIDER_KINDS)[number];

/**
 * Providers reached with somebody's linked account rather than credentials of
 * their own.
 *
 * Their secret is an OAuth refresh token, and it already lives on the
 * UserConnection the account was linked through. Copying it into the connection
 * as well would make two places to revoke and one of them would eventually be
 * missed - so these carry no credentials, and the app resolves an access token
 * from the linked account when a driver is built. Unlinking the account is then
 * what stops the connection working, which is what somebody unlinking it meant.
 */
export const LINKED_ACCOUNT_KINDS: readonly StorageProviderKind[] = ["gdrive", "onedrive", "dropbox"];

/** Whether this kind authorizes through a linked account instead of its own secret. */
export function usesLinkedAccount(kind: StorageProviderKind): boolean {
    return LINKED_ACCOUNT_KINDS.includes(kind);
}

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
    }),
    z.object({
        kind: z.literal("gdrive"),
        // The linked Google account, by the id Google gives it - the identity
        // that survives the address being renamed.
        accountId: z.string().min(1),
        // The folder everything lives under. Polaris creates it on first use and
        // records the id here: with the drive.file scope it can only ever see
        // what it created itself, so there is nothing else it could be given.
        rootFolderId: z.string().optional(),
        rootFolderName: z.string().default("Polaris")
    }),
    z.object({
        kind: z.literal("onedrive"),
        accountId: z.string().min(1),
        // Which drive on the account. Absent means the account's default drive,
        // which is what a personal account has exactly one of.
        driveId: z.string().optional(),
        rootFolderId: z.string().optional(),
        rootFolderName: z.string().default("Polaris")
    }),
    z.object({
        kind: z.literal("dropbox"),
        accountId: z.string().min(1),
        // Dropbox addresses by path, not by id. Rooted at the app folder when the
        // operator's app is scoped that way, which is the recommended setup.
        rootPath: z.string().default("/Polaris")
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
    z.object({ kind: z.literal("unifi-unas"), password: z.string().optional(), apiKey: z.string().optional() }),
    // Nothing to hold: these authorize through the linked account's own token.
    z.object({ kind: z.literal("gdrive") }),
    z.object({ kind: z.literal("onedrive") }),
    z.object({ kind: z.literal("dropbox") })
]);

export type StorageCredentials = z.infer<typeof storageCredentialsSchema>;

/** Payload the create-connection form/API accepts (config + credentials + name). */
export const createConnectionSchema = z.object({
    name: z.string().min(1).max(120),
    config: storageConfigSchema,
    credentials: storageCredentialsSchema
});

export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;

/**
 * Payload for taking a storage connection out of Polaris. `forget` stops using the
 * device and touches nothing on it; `move` copies its content to another
 * connection, repoints the services that mount it, and only then forgets it - so
 * that one needs a destination.
 */
export const removeConnectionSchema = z
    .object({
        mode: z.enum(["forget", "move"]),
        destinationId: z.string().uuid().optional()
    })
    .refine((value) => value.mode !== "move" || Boolean(value.destinationId), {
        message: "Choose where the content should go",
        path: ["destinationId"]
    });

export type RemoveConnectionInput = z.infer<typeof removeConnectionSchema>;

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
