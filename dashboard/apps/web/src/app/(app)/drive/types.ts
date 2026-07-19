/** Client-safe shapes for the Drive explorer (bigint/Date already serialized). */

import type { StorageProviderKind } from "@polaris/core";

export interface ConnectionSummary {
    id: string;
    name: string;
    kind: StorageProviderKind;
    requiresHostd: boolean;
    /** The device's own local console URL (UniFi UNAS), for a direct-open shortcut. */
    webUrl?: string;
    /** True when another user shared this connection with the viewer via an ACL. */
    shared?: boolean;
    /** True when the viewer owns the connection and may manage its access settings. */
    canManageAccess?: boolean;
    /** Non-secret connection config (host, port, share, ...) for the edit form. */
    config?: Record<string, unknown>;
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
