/** Client-safe shapes for the Drive explorer (bigint/Date already serialized). */

import type { StorageProviderKind } from "@polaris/core";

/**
 * Whether a source is a saved storage connection, as opposed to one Drive borrows
 * from another app: a registered server browsed over SFTP (`host:<id>`) or a
 * running container (`container:<id>`). Both are browsed like any other location,
 * but everything that hangs off a connection row - shares, file requests, access
 * rules, editing or removing the connection itself - has nothing to attach to, so
 * it is not offered rather than offered and then failing.
 */
export function isSavedConnection(connectionId: string): boolean {
    return !connectionId.includes(":");
}

/** Whether a source is a registered server browsed over SFTP. The prefix mirrors
 *  HOST_CONNECTION_PREFIX in the storage service, which is server-only and
 *  cannot be imported here. */
export function isServerSource(connectionId: string): boolean {
    return connectionId.startsWith("host:");
}

/** Reachability of one source, as answered by /api/drive/source-status. Sources
 *  with no machine to reach (a bucket, a local path, a container on this box) are
 *  absent from that answer rather than reported up. */
export interface SourceStatus {
    /** The Drive source id, prefix included. */
    id: string;
    state: "up" | "down";
    /** Why it is not answering, in the words the connection used. */
    detail: string | null;
    /**
     * Where Polaris dialled, as `host:port`.
     *
     * Carried because the reason on its own is not actionable: "that address does
     * not resolve" is a different afternoon depending on whether the address is a
     * public name, a machine name only the office DNS knows, or an IP that has
     * since been reassigned - and the one person who can tell them apart is the
     * one reading the screen. It is nothing they cannot already see on the
     * connection itself.
     */
    endpoint: string | null;
}

/**
 * Whether a source looks like it points at a machine, and so whether polling
 * reachability can say anything at all. A hint for turning the poll off on an
 * instance that only browses buckets and local paths - the server decides what is
 * actually probed and remains the only authority on whether a source is down.
 */
export function mayBeUnreachable(connection: ConnectionSummary): boolean {
    return (
        isServerSource(connection.id) ||
        typeof connection.config?.host === "string" ||
        typeof connection.config?.baseUrl === "string"
    );
}

export interface ConnectionSummary {
    id: string;
    name: string;
    kind: StorageProviderKind;
    requiresHostd: boolean;
    /** The device's own local console URL (UniFi UNAS), for a direct-open shortcut. */
    webUrl?: string;
    /** True when another user shared this connection with the viewer via an ACL. */
    shared?: boolean;
    /** Where this location opens, and the shallowest folder in it the viewer may
     *  reach. Empty for a storage of their own, which opens at its root; a folder
     *  somebody shared opens at that folder, because everything above it would
     *  refuse them. */
    rootPath?: string;
    /** True when the viewer owns the connection and may manage its access settings. */
    canManageAccess?: boolean;
    /** True when this is a storage somebody connected and can therefore change or
     *  remove. A personal drive is neither: Polaris made it, its settings are not
     *  anybody's to edit, and it goes when the account does. */
    editable?: boolean;
    /** Non-secret connection config (host, port, share, ...) for the edit form. */
    config?: Record<string, unknown>;
    /** True when the stored credentials were encrypted under a previous master
     *  key and can no longer be decrypted, so they must be re-entered. */
    needsRekey?: boolean;
}

export interface DriveEntry {
    name: string;
    path: string;
    kind: "file" | "dir" | "symlink";
    /** Byte size serialized as a string to cross the server/client boundary. */
    size: string;
    modifiedAt: string;
    createdAt: string;
    /** User-set presentation metadata (merged from DriveItemMeta), when present. */
    hidden?: boolean;
    favorite?: boolean;
    icon?: string | null;
    iconColor?: string | null;
    note?: string | null;
    /** Display name of the Polaris user who uploaded/created this item, if known. */
    owner?: string | null;
    /** True when this folder is itself an access-gate (lock) root. */
    locked?: boolean;
}
