/**
 * SMB / CIFS driver (userspace). Talks SMB2 directly with a pure-JS client, so it
 * works in the limited edition without a kernel mount or the host daemon - the
 * practical way to browse a NAS that exposes a Windows/Samba share (a UniFi UNAS,
 * Synology, TrueNAS, ...) using the same account credentials. Reads and writes
 * stream without buffering, and every user path is confined under the share root.
 * The native (kernel-mount) path via polaris-hostd remains preferred when the full
 * edition is available - it is faster - but this keeps SMB usable everywhere.
 *
 * The session is either the driver's own (`SmbConnectOptions`, which opens it and
 * closes it) or borrowed (`SmbSessionOptions`, where a caller that pools sessions
 * lends one). Opening one is a TCP connect, a negotiate, an NTLM session setup, a
 * tree connect and - because that is how this client proves it works - a listing of
 * the whole share root. Paying that per request is what made a NAS feel slower than
 * it is.
 */

import SMB2 from "v9u-smb2";
import { Readable } from "node:stream";
import type { Writable } from "node:stream";
import { baseName, normalizeRelPath, withTimeout } from "@polaris/core";
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

/** Options for a driver that opens its own session and closes it on `dispose`. */
export interface SmbConnectOptions {
    readonly id: string;
    readonly host: string;
    readonly port: number;
    readonly share: string;
    readonly domain?: string;
    readonly username?: string;
    readonly password?: string;
}

/** Options for a driver over a session somebody else owns and keeps open. Same
 *  reason as the SFTP driver's: negotiate, session setup and tree connect cost far
 *  more than the call that follows them, and a NAS is browsed a folder at a time. */
export interface SmbSessionOptions {
    readonly id: string;
    readonly session: () => Promise<SmbSession>;
    readonly endSession?: () => void;
}

export type SmbDriverOptions = SmbConnectOptions | SmbSessionOptions;

/** Whether these options lend a session rather than describe one to open. */
function isBorrowed(options: SmbDriverOptions): options is SmbSessionOptions {
    return "session" in options;
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

/** A connected SMB2 session. Exported so a caller that pools sessions can hold one. */
export interface SmbSession {
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

/**
 * Open an SMB session and prove it works, or throw with the reason.
 *
 * Exported because a caller that pools sessions needs to open one without a driver
 * around it - and must open it exactly the way the driver does, credential check
 * included, or a pooled session would be one nobody ever verified.
 */
export async function openSmbSession(options: Omit<SmbConnectOptions, "id">): Promise<SmbSession> {
    const Ctor = SMB2 as unknown as new (options: Record<string, unknown>) => SmbSession;
    const client = new Ctor({
        share: `\\\\${options.host}\\${options.share}`,
        domain: options.domain || "WORKGROUP",
        username: options.username || "guest",
        password: options.password ?? "",
        port: options.port || 445,
        // Keep the connection open; whoever opened it decides when it closes.
        autoCloseTimeout: 0
    });
    try {
        // A listing of the root doubles as a connection/credential check, with a
        // timeout so a filtered port or a hung negotiation fails fast rather than
        // leaving the request hanging.
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
        // Surface the real cause so the user can act: STATUS_LOGON_FAILURE -> wrong
        // account, STATUS_BAD_NETWORK_NAME -> wrong share, ECONNREFUSED -> SMB off
        // or port closed.
        throw new StorageError("connection_failed", `SMB connection failed: ${message(error)}`);
    }
    return client;
}

/** How long a finished write waits for the file handle to be closed before
 *  carrying on without it. Long enough for a server on a LAN to answer, short
 *  enough that a client which never sends `close` costs a quarter of a second. */
const CLOSE_GRACE_MS = 250;

export class SmbDriver implements StorageDriver {
    public readonly id: string;
    public readonly kind = "smb" as const;
    public readonly capabilities = SMB_CAPABILITIES;
    private readonly options: SmbDriverOptions;
    private client?: SmbSession;

    public constructor(options: SmbDriverOptions) {
        this.id = options.id;
        this.options = options;
    }

    /** POSIX-relative -> SMB path (backslash separators; "" is the share root). */
    private smbPath(rel: string): string {
        return rel.replace(/\//g, "\\");
    }

    public async connect(): Promise<void> {
        // A lent session is already negotiated and authenticated, and its lender
        // checked it - there is nothing to do here but take it.
        this.client = isBorrowed(this.options)
            ? await this.options.session()
            : await openSmbSession(this.options);
    }

    public async dispose(): Promise<void> {
        // A borrowed session goes back to its lender, which decides when it closes;
        // hanging up on it here would take the next operation's session with it.
        if (isBorrowed(this.options)) {
            this.options.endSession?.();
            this.client = undefined;
            return;
        }
        try {
            this.client?.disconnect();
        } catch {
            // Best effort; the socket is torn down regardless.
        }
        this.client = undefined;
    }

    private c(): SmbSession {
        if (!this.client) throw new StorageError("connection_failed", "SMB not connected");
        return this.client;
    }

    public async list(path: string, _options?: ListOptions): Promise<ListResult> {
        const rel = normalizeRelPath(path);
        let raw: SmbStat[] | SmbStat[][];
        try {
            raw = await this.c().readdir(this.smbPath(rel), { stats: true });
        } catch (error) {
            throw new StorageError(
                "io_error",
                `Cannot list ${path || "the share root"}: ${message(error)}`
            );
        }
        // The client may return either a flat list or an array of batches.
        const items = (
            Array.isArray(raw[0]) ? (raw as SmbStat[][]).flat() : (raw as SmbStat[])
        ).filter((item) => item.name && item.name !== "." && item.name !== "..");
        const entries: StatEntry[] = items.map((item) =>
            toEntry(
                item.name as string,
                rel === "" ? (item.name as string) : `${rel}/${item.name}`,
                item
            )
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
        // When a client aborts a download mid-stream, the SMB library tears down the
        // file handle and can emit STATUS_FILE_CLOSED as an 'error' AFTER the web
        // stream has already removed its own listener. With no listener that becomes
        // an unhandled exception. Keep a persistent no-op listener so an aborted
        // download is harmless; genuine read errors still reach the consumer via the
        // web stream's own error propagation while it is active.
        nodeStream.on("error", () => {
            /* swallowed: abort/teardown races are expected here */
        });
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
            let settled = false;
            const done = () => {
                if (settled) return;
                settled = true;
                clearTimeout(grace);
                resolve();
            };
            let grace: ReturnType<typeof setTimeout>;

            /**
             * Wait for the handle to be closed, not merely for the bytes to be
             * written.
             *
             * `finish` says this end has flushed; `close` says the server has
             * let go of the file. Returning on the first and then hanging up the
             * session leaves the handle open on the other side, and an SMB
             * server holds a lock on an orphaned handle for as long as it takes
             * to reap the session - during which the file is there, it stats
             * correctly, and every attempt to READ it is refused. Which is
             * exactly what an attachment that uploads cleanly and then will not
             * open looks like.
             *
             * The grace exists because not every writable implementation emits
             * `close`, and waiting forever for an event that is not coming would
             * be a worse bug than the one this fixes.
             */
            out.on("close", done);
            out.on("finish", () => {
                grace = setTimeout(done, CLOSE_GRACE_MS);
            });
            out.on("error", reject);

            const source = Readable.fromWeb(body as import("node:stream/web").ReadableStream);
            source.on("error", reject);
            source.pipe(out);
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
        } catch (caught) {
            const detail = caught instanceof Error && caught.message ? `: ${caught.message}` : "";
            throw new StorageError("io_error", `Failed to move ${from}${detail}`);
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
            } catch (caught) {
                const detail =
                    caught instanceof Error && caught.message ? `: ${caught.message}` : "";
                throw new StorageError("io_error", `Failed to delete ${rel}${detail}`);
            }
        } else {
            try {
                await this.c().unlink(this.smbPath(rel));
            } catch (caught) {
                const detail =
                    caught instanceof Error && caught.message ? `: ${caught.message}` : "";
                throw new StorageError("io_error", `Failed to delete ${rel}${detail}`);
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
        createdAt:
            stat.btime instanceof Date
                ? stat.btime
                : stat.birthtime instanceof Date
                  ? stat.birthtime
                  : undefined
    };
}

function parentOf(rel: string): string {
    const idx = rel.lastIndexOf("/");
    return idx < 0 ? "" : rel.slice(0, idx);
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
