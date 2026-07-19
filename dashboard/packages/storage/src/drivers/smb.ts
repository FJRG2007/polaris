/**
 * SMB / CIFS driver (userspace). Talks SMB2 directly with a pure-JS client, so it
 * works in the limited edition without a kernel mount or the host daemon - the
 * practical way to browse a NAS that exposes a Windows/Samba share (a UniFi UNAS,
 * Synology, TrueNAS, ...) using the same account credentials. One connection per
 * share backs the driver; reads and writes stream without buffering, and every
 * user path is confined under the share root. The native (kernel-mount) path via
 * polaris-hostd remains preferred when the full edition is available - it is
 * faster - but this keeps SMB usable everywhere.
 */

import { Readable } from "node:stream";
import type { Writable } from "node:stream";
import SMB2 from "v9u-smb2";
import { baseName, normalizeRelPath } from "@polaris/core";
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

const SMB_CAPABILITIES: StorageDriverCapabilities = {
    // The pure-JS client streams whole files reliably; byte-range reads and offset
    // writes are left off until proven against real servers, so downloads fetch
    // the whole object and uploads always start fresh.
    randomRead: false,
    randomWrite: false,
    move: true,
    usage: false,
    requiresHostd: false
};

export interface SmbDriverOptions {
    readonly id: string;
    readonly host: string;
    readonly port: number;
    readonly share: string;
    readonly domain?: string;
    readonly username?: string;
    readonly password?: string;
}

/** The stat shape the SMB client returns for readdir({stats:true}) and stat(). */
interface SmbStat {
    name?: string;
    size: number;
    mtime: Date;
    /** Birth/creation time, when the SMB server reports it. */
    btime?: Date;
    birthtime?: Date;
    isDirectory(): boolean;
}

interface SmbClient {
    readdir(path: string, options: { stats: true }): Promise<SmbStat[] | SmbStat[][]>;
    stat(path: string): Promise<SmbStat>;
    createReadStream(path: string): Promise<Readable>;
    createWriteStream(path: string): Promise<Writable>;
    mkdir(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    unlink(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    disconnect(): void;
}

export class SmbDriver implements StorageDriver {
    public readonly id: string;
    public readonly kind = "smb" as const;
    public readonly capabilities = SMB_CAPABILITIES;
    private readonly options: SmbDriverOptions;
    private client?: SmbClient;

    public constructor(options: SmbDriverOptions) {
        this.id = options.id;
        this.options = options;
    }

    /** POSIX-relative -> SMB path (backslash separators; "" is the share root). */
    private smbPath(rel: string): string {
        return rel.replace(/\//g, "\\");
    }

    public async connect(): Promise<void> {
        const Ctor = SMB2 as unknown as new (options: Record<string, unknown>) => SmbClient;
        const client = new Ctor({
            share: `\\\\${this.options.host}\\${this.options.share}`,
            domain: this.options.domain || "WORKGROUP",
            username: this.options.username || "guest",
            password: this.options.password ?? "",
            port: this.options.port || 445,
            // Keep the connection open; the driver closes it in dispose().
            autoCloseTimeout: 0
        });
        try {
            // A listing of the root doubles as a connection/credential check, with
            // a timeout so a filtered port or a hung negotiation fails fast rather
            // than leaving the request hanging.
            await withTimeout(
                client.readdir("", { stats: true }),
                12_000,
                "timed out reaching SMB on port 445 (is SMB enabled and the host reachable?)"
            );
        } catch (error) {
            try {
                client.disconnect();
            } catch {
                // ignore
            }
            // Surface the real cause so the user can act: STATUS_LOGON_FAILURE ->
            // wrong account, STATUS_BAD_NETWORK_NAME -> wrong share, ECONNREFUSED
            // -> SMB off / port closed.
            throw new StorageError("connection_failed", `SMB connection failed: ${message(error)}`);
        }
        this.client = client;
    }

    public async dispose(): Promise<void> {
        try {
            this.client?.disconnect();
        } catch {
            // Best effort; the socket is torn down regardless.
        }
        this.client = undefined;
    }

    private c(): SmbClient {
        if (!this.client) throw new StorageError("connection_failed", "SMB not connected");
        return this.client;
    }

    public async list(path: string, _options?: ListOptions): Promise<ListResult> {
        const rel = normalizeRelPath(path);
        let raw: SmbStat[] | SmbStat[][];
        try {
            raw = await this.c().readdir(this.smbPath(rel), { stats: true });
        } catch (error) {
            throw new StorageError("io_error", `Cannot list ${path || "the share root"}: ${message(error)}`);
        }
        // The client may return either a flat list or an array of batches.
        const items = (Array.isArray(raw[0]) ? (raw as SmbStat[][]).flat() : (raw as SmbStat[])).filter(
            (item) => item.name && item.name !== "." && item.name !== ".."
        );
        const entries: StatEntry[] = items.map((item) =>
            toEntry(item.name as string, rel === "" ? (item.name as string) : `${rel}/${item.name}`, item)
        );
        entries.sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        return { entries };
    }

    public async stat(path: string): Promise<StatEntry> {
        const rel = normalizeRelPath(path);
        try {
            const stat = await this.c().stat(this.smbPath(rel));
            return toEntry(baseName(rel) || rel, rel, stat);
        } catch {
            throw new StorageError("not_found", `Not found: ${path}`);
        }
    }

    public async readStream(path: string, _range?: ReadRange): Promise<ReadableStream<Uint8Array>> {
        const nodeStream = await this.c().createReadStream(this.smbPath(normalizeRelPath(path)));
        return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    }

    public async writeStream(
        path: string,
        body: ReadableStream<Uint8Array>,
        _options?: WriteOptions
    ): Promise<StatEntry> {
        const rel = normalizeRelPath(path);
        await this.mkdirp(parentOf(rel));
        const out = await this.c().createWriteStream(this.smbPath(rel));
        await new Promise<void>((resolve, reject) => {
            Readable.fromWeb(body as import("node:stream/web").ReadableStream)
                .pipe(out)
                .on("finish", resolve)
                .on("error", reject);
        });
        return this.stat(rel);
    }

    public async mkdir(path: string): Promise<void> {
        await this.mkdirp(normalizeRelPath(path));
    }

    public async move(from: string, to: string): Promise<void> {
        const dstRel = normalizeRelPath(to);
        await this.mkdirp(parentOf(dstRel));
        try {
            await this.c().rename(this.smbPath(normalizeRelPath(from)), this.smbPath(dstRel));
        } catch {
            throw new StorageError("io_error", `Failed to move ${from}`);
        }
    }

    public async delete(path: string, options?: { recursive?: boolean }): Promise<void> {
        const rel = normalizeRelPath(path);
        const entry = await this.stat(rel);
        if (entry.kind === "dir") {
            if (options?.recursive ?? true) {
                const listing = await this.list(rel);
                for (const child of listing.entries) {
                    await this.delete(child.path, { recursive: true });
                }
            }
            try {
                await this.c().rmdir(this.smbPath(rel));
            } catch {
                throw new StorageError("io_error", "rmdir failed");
            }
        } else {
            try {
                await this.c().unlink(this.smbPath(rel));
            } catch {
                throw new StorageError("io_error", "delete failed");
            }
        }
    }

    public async usage(): Promise<StorageUsage> {
        // The SMB2 client exposes no volume-size query; report nothing rather than guess.
        return {};
    }

    /** Create a directory and any missing parents (SMB mkdir is not recursive). */
    private async mkdirp(rel: string): Promise<void> {
        if (rel === "") return;
        const segments = rel.split("/");
        let current = "";
        for (const segment of segments) {
            current = current === "" ? segment : `${current}/${segment}`;
            try {
                await this.c().mkdir(this.smbPath(current));
            } catch {
                // Already exists (or a race): ignore and continue building the path.
            }
        }
    }
}

function toEntry(name: string, path: string, stat: SmbStat): StatEntry {
    return {
        name,
        path,
        kind: stat.isDirectory() ? "dir" : "file",
        size: BigInt(Math.max(0, Math.trunc(Number(stat.size ?? 0)) || 0)),
        modifiedAt: stat.mtime instanceof Date ? stat.mtime : new Date(Number(stat.mtime ?? 0)),
        createdAt: stat.btime instanceof Date ? stat.btime : stat.birthtime instanceof Date ? stat.birthtime : undefined
    };
}

function parentOf(rel: string): string {
    const idx = rel.lastIndexOf("/");
    return idx < 0 ? "" : rel.slice(0, idx);
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Reject with a clear message if a promise does not settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(reason)), ms);
        if (typeof timer.unref === "function") timer.unref();
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}
