/**
 * Driver registry. Given a stored connection and the current edition
 * capabilities, this decides HOW to talk to the backend: an in-process driver
 * for userspace/API providers, or a proxy to polaris-hostd for providers that
 * need a kernel mount or host filesystem access. The hostd proxy is injected as
 * a factory so this package stays free of any transport dependency and can be
 * unit-tested without a running daemon.
 */

import { prefersHostd, requiresHostd } from "@polaris/core";
import type { StorageConfig, StorageCredentials, StorageProviderKind } from "@polaris/core";
import type { Capabilities } from "@polaris/config";
import { LocalDriver } from "./drivers/local.js";
import { SftpDriver } from "./drivers/sftp.js";
import { StorageError, type StorageDriver } from "./driver.js";

/** A decrypted connection ready to drive. Credentials are already plaintext here. */
export interface ConnectionRecord {
    readonly id: string;
    readonly kind: StorageProviderKind;
    readonly config: StorageConfig;
    readonly credentials: StorageCredentials;
}

/** Injected by the app to build a driver that forwards operations to the daemon. */
export type HostdDriverFactory = (record: ConnectionRecord) => StorageDriver;

export interface DriverDeps {
    readonly capabilities: Capabilities;
    readonly hostdFactory?: HostdDriverFactory;
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
            return new SftpDriver({
                id: record.id,
                host: config.host,
                port: config.port ?? 22,
                username: config.username,
                root: config.root,
                password: creds.password,
                privateKey: creds.privateKey
            });
        }
        case "smb": {
            // Prefer a native mount when the daemon is present; the userspace SMB
            // fallback is not implemented yet, so be explicit rather than pretend.
            if (prefersHostd(record.kind) && deps.capabilities.nativeMounts && deps.hostdFactory) {
                return deps.hostdFactory(record);
            }
            throw new StorageError(
                "not_supported",
                "SMB currently requires the host daemon; the userspace fallback is pending"
            );
        }
        default:
            throw new StorageError(
                "not_supported",
                `The ${record.kind} driver is not implemented yet`
            );
    }
}
