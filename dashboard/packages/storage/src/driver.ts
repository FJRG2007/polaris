/**
 * The storage-provider contract. This interface is the seam that lets Polaris
 * "connect any NAS in any way" - every provider (local disk, SFTP, WebDAV, S3,
 * SMB/NFS mounts, and vendor APIs) implements the same shape, and the rest of
 * the app never learns which one it is talking to.
 *
 * It is streaming-first on purpose: files can be far larger than memory, so we
 * pass web-standard ReadableStream/Uint8Array bodies that compose directly with
 * Next.js Route Handlers and with the host daemon's HTTP bodies, never buffering
 * a whole file. It is also capability-declaring so the UI can hide operations a
 * given backend cannot perform instead of failing them at runtime.
 *
 * This interface is a frozen contract: additive changes only. Drivers and both
 * editions depend on it, so breaking it breaks everything downstream.
 */

import type { StorageProviderKind } from "@polaris/core";

export interface StorageDriverCapabilities {
    /** Supports byte-range reads (seek) - enables video scrubbing and resume. */
    readonly randomRead: boolean;
    /** Supports offset writes - enables native resumable upload without staging. */
    readonly randomWrite: boolean;
    /** Has a native rename/move rather than copy-then-delete. */
    readonly move: boolean;
    /** Can report quota/used/free for the connection. */
    readonly usage: boolean;
    /** Must route through the privileged host daemon (kernel mount / host FS). */
    readonly requiresHostd: boolean;
}

/** One entry in a directory listing or the result of a stat. */
export interface StatEntry {
    readonly name: string;
    /** Provider-relative, POSIX-normalized path (no leading slash). */
    readonly path: string;
    readonly kind: "file" | "dir" | "symlink";
    /** Size in bytes; bigint because files can exceed 2^53. */
    readonly size: bigint;
    readonly modifiedAt: Date;
    /** Creation/birth time when the backend reports one (falls back to modified). */
    readonly createdAt?: Date;
    /** Backend change token, when available (used for resume + cache validation). */
    readonly etag?: string;
    readonly mime?: string;
}

/** An inclusive byte range for a partial read. `end` omitted means to EOF. */
export interface ReadRange {
    readonly start: number;
    readonly end?: number;
}

export interface ListOptions {
    /** Opaque continuation token from a previous page. */
    readonly cursor?: string;
    readonly limit?: number;
}

export interface ListResult {
    readonly entries: readonly StatEntry[];
    readonly nextCursor?: string;
}

export interface WriteOptions {
    /** Start offset for a resumable write; requires capabilities.randomWrite. */
    readonly offset?: number;
    /** Total size hint, when known, so backends can pre-allocate. */
    readonly size?: bigint;
    readonly mime?: string;
}

export interface StorageUsage {
    readonly total?: bigint;
    readonly used?: bigint;
    readonly free?: bigint;
}

export interface StorageDriver {
    readonly id: string;
    readonly kind: StorageProviderKind;
    readonly capabilities: StorageDriverCapabilities;

    /** Validate credentials and open any pool/session. Throws on failure. */
    connect(): Promise<void>;
    /** Release resources. Safe to call more than once. */
    dispose(): Promise<void>;

    list(path: string, options?: ListOptions): Promise<ListResult>;
    stat(path: string): Promise<StatEntry>;
    readStream(path: string, range?: ReadRange): Promise<ReadableStream<Uint8Array>>;
    writeStream(
        path: string,
        body: ReadableStream<Uint8Array>,
        options?: WriteOptions
    ): Promise<StatEntry>;
    mkdir(path: string): Promise<void>;
    move(from: string, to: string): Promise<void>;
    delete(path: string, options?: { recursive?: boolean }): Promise<void>;
    usage(): Promise<StorageUsage>;
}

/** Raised for storage-layer failures with a machine-readable code. */
export class StorageError extends Error {
    public readonly code: StorageErrorCode;
    public constructor(code: StorageErrorCode, message: string) {
        super(message);
        this.name = "StorageError";
        this.code = code;
    }
}

export type StorageErrorCode =
    | "not_found"
    | "already_exists"
    | "permission_denied"
    | "not_supported"
    | "capability_required"
    | "connection_failed"
    | "io_error";
