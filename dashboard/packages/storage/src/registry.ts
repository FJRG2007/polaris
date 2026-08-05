/**
 * Driver registry. Given a stored connection and the current edition
 * capabilities, this decides HOW to talk to the backend: an in-process driver
 * for userspace/API providers, or a proxy to polaris-hostd for providers that
 * need a kernel mount or host filesystem access. The hostd proxy is injected as
 * a factory so this package stays free of any transport dependency and can be
 * unit-tested without a running daemon.
 */

import { LocalDriver } from "./drivers/local.js";
import type { Capabilities } from "@polaris/config";
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
export type SftpSessionFactory = (record: ConnectionRecord) => Pick<SftpSessionOptions, "session" | "endSession">;

/** The same for SMB, whose session setup costs more than SSH's - it ends in a
 *  listing of the whole share root. */
export type SmbSessionFactory = (record: ConnectionRecord) => Pick<SmbSessionOptions, "session" | "endSession">;

export interface DriverDeps {
    readonly capabilities: Capabilities;
    readonly hostdFactory?: HostdDriverFactory;
    readonly sftpSessionFactory?: SftpSessionFactory;
    readonly smbSessionFactory?: SmbSessionFactory;
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
                return new SftpDriver({ id: record.id, root: config.root, ...deps.sftpSessionFactory(record) });
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
        default:
            throw new StorageError(
                "not_supported",
                `The ${record.kind} driver is not implemented yet`
            );
    }
}
