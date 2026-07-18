/**
 * Local filesystem driver. Serves a directory tree that lives inside the
 * container (or, when the registry routes a host path through the daemon, on the
 * host). Every user-supplied path is normalized and confined under the
 * connection root by @polaris/core's path helpers before it ever reaches fs, so
 * traversal out of the root is impossible.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { Readable } from "node:stream";
import { joinUnderRoot, normalizeRelPath, baseName } from "@polaris/core";
import {
    StorageError,
    type ListOptions,
    type ListResult,
    type ReadRange,
    type StatEntry,
    type StorageDriver,
    type StorageDriverCapabilities,
    type StorageUsage,
    type WriteOptions
} from "../driver.js";

const LOCAL_CAPABILITIES: StorageDriverCapabilities = {
    randomRead: true,
    randomWrite: true,
    move: true,
    usage: true,
    requiresHostd: false
};

export interface LocalDriverOptions {
    readonly id: string;
    /** Absolute root directory this connection is confined to. */
    readonly root: string;
}

export class LocalDriver implements StorageDriver {
    public readonly id: string;
    public readonly kind = "local" as const;
    public readonly capabilities = LOCAL_CAPABILITIES;
    private readonly root: string;

    public constructor(options: LocalDriverOptions) {
        this.id = options.id;
        this.root = options.root;
    }

    /** Resolve a provider-relative path to an absolute path under the root. */
    private resolve(path: string): string {
        return joinUnderRoot(this.root, path);
    }

    public async connect(): Promise<void> {
        try {
            const info = await stat(this.root);
            if (!info.isDirectory()) {
                throw new StorageError("connection_failed", "Root is not a directory");
            }
        } catch (error) {
            if (error instanceof StorageError) throw error;
            throw new StorageError("connection_failed", `Root not accessible: ${this.root}`);
        }
    }

    public async dispose(): Promise<void> {
        // Nothing to release for the local filesystem.
    }

    public async list(path: string, _options?: ListOptions): Promise<ListResult> {
        const rel = normalizeRelPath(path);
        const abs = this.resolve(rel);
        let dirents;
        try {
            dirents = await readdir(abs, { withFileTypes: true });
        } catch {
            throw new StorageError("not_found", `Directory not found: ${path}`);
        }
        const entries: StatEntry[] = [];
        for (const dirent of dirents) {
            const childRel = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
            try {
                entries.push(await this.stat(childRel));
            } catch {
                // Skip entries that vanish or are unreadable mid-listing.
            }
        }
        entries.sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        return { entries };
    }

    public async stat(path: string): Promise<StatEntry> {
        const rel = normalizeRelPath(path);
        const abs = this.resolve(rel);
        let info;
        try {
            info = await stat(abs);
        } catch {
            throw new StorageError("not_found", `Not found: ${path}`);
        }
        return {
            name: baseName(rel) || rel,
            path: rel,
            kind: info.isDirectory() ? "dir" : info.isSymbolicLink() ? "symlink" : "file",
            size: BigInt(info.size),
            modifiedAt: info.mtime
        };
    }

    public async readStream(path: string, range?: ReadRange): Promise<ReadableStream<Uint8Array>> {
        const abs = this.resolve(normalizeRelPath(path));
        const options = range ? { start: range.start, end: range.end } : undefined;
        const nodeStream = createReadStream(abs, options);
        return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    }

    public async writeStream(
        path: string,
        body: ReadableStream<Uint8Array>,
        options?: WriteOptions
    ): Promise<StatEntry> {
        const rel = normalizeRelPath(path);
        const abs = this.resolve(rel);
        await mkdir(joinUnderRoot(this.root, parentOf(rel)), { recursive: true });
        // An offset write resumes an interrupted upload: open r+ and seek. A fresh
        // write truncates. Either way we stream, never buffering the whole file.
        const writeOptions =
            options?.offset && options.offset > 0
                ? { flags: "r+", start: options.offset }
                : { flags: "w" };
        const out = createWriteStream(abs, writeOptions);
        await new Promise<void>((resolve, reject) => {
            Readable.fromWeb(body as import("node:stream/web").ReadableStream)
                .pipe(out)
                .on("finish", resolve)
                .on("error", reject);
        });
        return this.stat(rel);
    }

    public async mkdir(path: string): Promise<void> {
        await mkdir(this.resolve(normalizeRelPath(path)), { recursive: true });
    }

    public async move(from: string, to: string): Promise<void> {
        const src = this.resolve(normalizeRelPath(from));
        const dst = this.resolve(normalizeRelPath(to));
        await mkdir(joinUnderRoot(this.root, parentOf(normalizeRelPath(to))), { recursive: true });
        try {
            await rename(src, dst);
        } catch {
            throw new StorageError("io_error", `Failed to move ${from} -> ${to}`);
        }
    }

    public async delete(path: string, options?: { recursive?: boolean }): Promise<void> {
        const abs = this.resolve(normalizeRelPath(path));
        await rm(abs, { recursive: options?.recursive ?? true, force: false });
    }

    public async usage(): Promise<StorageUsage> {
        try {
            const fsStat = await statfs(this.root);
            const total = BigInt(fsStat.blocks) * BigInt(fsStat.bsize);
            const free = BigInt(fsStat.bavail) * BigInt(fsStat.bsize);
            return { total, free, used: total - free };
        } catch {
            return {};
        }
    }
}

/** Parent segment of a normalized relative path ("a/b/c" -> "a/b"; root -> ""). */
function parentOf(rel: string): string {
    const idx = rel.lastIndexOf("/");
    return idx < 0 ? "" : rel.slice(0, idx);
}
