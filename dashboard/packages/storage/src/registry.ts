/**
 * Driver registry. Given a stored connection and the current edition
 * capabilities, this decides HOW to talk to the backend: an in-process driver
 * for userspace/API providers, or a proxy to polaris-hostd for providers that
 * need a kernel mount or host filesystem access. The hostd proxy is injected as
 * a factory so this package stays free of any transport dependency and can be
 * unit-tested without a running daemon.
 */

import { S3Driver } from "./drivers/s3.js";
import { LocalDriver } from "./drivers/local.js";
import { GDriveDriver } from "./drivers/gdrive.js";
import type { Capabilities } from "@polaris/config";
import { DropboxDriver } from "./drivers/dropbox.js";
import { OneDriveDriver } from "./drivers/onedrive.js";
import type { TokenSource } from "./drivers/cloud-http.js";
import { prefersHostd, requiresHostd } from "@polaris/core";
import { StorageError, type StorageDriver } from "./driver.js";
import { SmbDriver, type SmbSessionOptions } from "./drivers/smb.js";
import { SftpDriver, type SftpSessionOptions } from "./drivers/sftp.js";
import type { StorageConfig, StorageCredentials, StorageProviderKind } from "@polaris/core";

/** A decrypted connection ready to drive. Credentials are already plaintext here. */
export interface ConnectionRecord {
    readonly id: string;
    readonly kind: StorageProviderKind;
    readonly config: StorageConfig;
    readonly credentials: StorageCredentials;
}

/** Injected by the app to build a driver that forwards operations to the daemon. */
export type HostdDriverFactory = (record: ConnectionRecord) => StorageDriver;

/** Injected by the app to lend an SFTP connection it pools, instead of letting the
 *  driver open and throw away one of its own per operation. */
export type SftpSessionFactory = (
    record: ConnectionRecord
) => Pick<SftpSessionOptions, "session" | "endSession">;

/** The same for SMB, whose session setup costs more than SSH's - it ends in a
 *  listing of the whole share root. */
export type SmbSessionFactory = (
    record: ConnectionRecord
) => Pick<SmbSessionOptions, "session" | "endSession">;

/**
 * Injected by the app to supply an access token for a connection that authorizes
 * through somebody's linked account.
 *
 * A function per request rather than a token per driver: these expire hourly and
 * a large upload outlives one, so the driver asks again instead of signing the
 * last chunk with a credential that died mid-transfer. This package holds no
 * database and no OAuth client, which is why it is injected rather than built.
 */
export type OAuthTokenFactory = (record: ConnectionRecord) => TokenSource;

/** Persist a folder id the driver had to create, so the next operation reuses it
 *  instead of creating a second one. */
export type RootFolderRecorder = (record: ConnectionRecord, folderId: string) => void | Promise<void>;

export interface DriverDeps {
    readonly capabilities: Capabilities;
    readonly hostdFactory?: HostdDriverFactory;
    readonly sftpSessionFactory?: SftpSessionFactory;
    readonly smbSessionFactory?: SmbSessionFactory;
    readonly oauthTokenFactory?: OAuthTokenFactory;
    readonly onRootFolderResolved?: RootFolderRecorder;
}

/**
 * Build the driver for a connection. Providers that require the daemon fail
 * clearly with capability_required in the limited edition rather than silently
 * degrading; providers that merely prefer it fall back to their userspace path
 * when the daemon is absent.
 */
export function createDriver(record: ConnectionRecord, deps: DriverDeps): StorageDriver {
    if (requiresHostd(record.kind)) {
        if (deps.capabilities.nativeMounts && deps.hostdFactory) {
            return deps.hostdFactory(record);
        }
        throw new StorageError(
            "capability_required",
            `${record.kind} needs the host daemon; unlock the full edition to use it`
        );
    }

    switch (record.kind) {
        case "local": {
            const config = record.config as Extract<StorageConfig, { kind: "local" }>;
            return new LocalDriver({ id: record.id, root: config.root });
        }
        case "sftp": {
            const config = record.config as Extract<StorageConfig, { kind: "sftp" }>;
            const creds = record.credentials as Extract<StorageCredentials, { kind: "sftp" }>;
            // A lent connection when the app pools them, so browsing a NAS over SFTP
            // does not re-authenticate per listing either.
            if (deps.sftpSessionFactory) {
                return new SftpDriver({
                    id: record.id,
                    root: config.root,
                    ...deps.sftpSessionFactory(record)
                });
            }
            return new SftpDriver({
                id: record.id,
                host: config.host,
                port: config.port ?? 22,
                username: config.username,
                root: config.root,
                password: creds.password,
                privateKey: creds.privateKey,
                passphrase: creds.passphrase
            });
        }
        case "smb": {
            // Prefer a native kernel mount via the daemon when available (faster);
            // otherwise fall back to the userspace SMB2 client so SMB works in the
            // limited edition too.
            if (prefersHostd(record.kind) && deps.capabilities.nativeMounts && deps.hostdFactory) {
                return deps.hostdFactory(record);
            }
            // A lent session when the app pools them, so a share browsed folder by
            // folder negotiates and logs in once instead of per request.
            if (deps.smbSessionFactory) {
                return new SmbDriver({ id: record.id, ...deps.smbSessionFactory(record) });
            }
            const config = record.config as Extract<StorageConfig, { kind: "smb" }>;
            const creds = record.credentials as Extract<StorageCredentials, { kind: "smb" }>;
            return new SmbDriver({
                id: record.id,
                host: config.host,
                port: config.port ?? 445,
                share: config.share,
                domain: config.domain,
                username: config.username,
                password: creds.password
            });
        }
        case "s3": {
            const config = record.config as Extract<StorageConfig, { kind: "s3" }>;
            const creds = record.credentials as Extract<StorageCredentials, { kind: "s3" }>;
            return new S3Driver({
                id: record.id,
                bucket: config.bucket,
                region: config.region,
                accessKeyId: config.accessKeyId,
                secretAccessKey: creds.secretAccessKey,
                endpoint: config.endpoint,
                forcePathStyle: config.forcePathStyle
            });
        }
        case "gdrive": {
            const config = record.config as Extract<StorageConfig, { kind: "gdrive" }>;
            return new GDriveDriver({
                id: record.id,
                token: linkedToken(record, deps),
                rootFolderId: config.rootFolderId,
                rootFolderName: config.rootFolderName,
                onRootResolved: (folderId) => deps.onRootFolderResolved?.(record, folderId)
            });
        }
        case "onedrive": {
            const config = record.config as Extract<StorageConfig, { kind: "onedrive" }>;
            return new OneDriveDriver({
                id: record.id,
                token: linkedToken(record, deps),
                driveId: config.driveId,
                rootFolderName: config.rootFolderName
            });
        }
        case "dropbox": {
            const config = record.config as Extract<StorageConfig, { kind: "dropbox" }>;
            return new DropboxDriver({
                id: record.id,
                token: linkedToken(record, deps),
                rootPath: config.rootPath
            });
        }
        default:
            throw new StorageError(
                "not_supported",
                `The ${record.kind} driver is not implemented yet`
            );
    }
}

/**
 * The token supply for a linked-account provider.
 *
 * Missing it is a wiring mistake rather than a user-facing one, but it surfaces
 * when somebody opens a connection - so it says which piece is absent instead of
 * failing later as an unauthorized request nobody can explain.
 */
function linkedToken(record: ConnectionRecord, deps: DriverDeps): TokenSource {
    const factory = deps.oauthTokenFactory;
    if (!factory) {
        throw new StorageError(
            "capability_required",
            `${record.kind} needs a linked account; no token supplier is configured`
        );
    }
    return factory(record);
}
