/**
 * SFTP driver. Serves a remote filesystem over SSH - the practical way to connect
 * a NAS (UniFi UNAS, Synology, etc.) in the limited edition, since it needs no
 * kernel mount and no host daemon, just SSH access. One ssh2 connection backs the
 * driver; reads and writes stream through the SFTP channel without buffering, and
 * every user path is confined under the connection root before it is used.
 */

import { Readable } from "node:stream";
import type { Client, SFTPWrapper } from "ssh2";
import { openSshClient } from "@polaris/ssh";
import { baseName, joinUnderRoot, normalizeRelPath } from "@polaris/core";
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

const SFTP_CAPABILITIES: StorageDriverCapabilities = {
    randomRead: true,
    randomWrite: true,
    move: true,
    usage: false,
    requiresHostd: false
};

export interface SftpDriverOptions {
    readonly id: string;
    readonly host: string;
    readonly port: number;
    readonly username: string;
    readonly root: string;
    readonly password?: string;
    readonly privateKey?: string;
    readonly passphrase?: string;
    /** Pinned server public key (base64). When set, a changed key is refused;
     *  when absent (legacy connections), the first key is trusted. */
    readonly pinnedHostKey?: string;
    /** Receives the server key (base64) on connect, for trust-on-add capture. */
    readonly onHostKey?: (hostKey: string) => void;
}

export class SftpDriver implements StorageDriver {
    public readonly id: string;
    public readonly kind = "sftp" as const;
    public readonly capabilities = SFTP_CAPABILITIES;
    private readonly options: SftpDriverOptions;
    private client?: Client;
    private sftp?: SFTPWrapper;

    public constructor(options: SftpDriverOptions) {
        this.id = options.id;
        this.options = options;
    }

    private resolve(path: string): string {
        return joinUnderRoot(this.options.root || "/", path);
    }

    public async connect(): Promise<void> {
        // Auth method follows the material provided: a private key when present,
        // otherwise a password. Host-key pinning + auth live in @polaris/ssh.
        const auth = this.options.privateKey
            ? ({
                  method: "key" as const,
                  privateKey: this.options.privateKey,
                  passphrase: this.options.passphrase
              })
            : ({ method: "password" as const, password: this.options.password ?? "" });
        let client: Client;
        try {
            client = await openSshClient({
                host: this.options.host,
                port: this.options.port,
                username: this.options.username,
                auth,
                pinnedHostKey: this.options.pinnedHostKey,
                onHostKey: this.options.onHostKey
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new StorageError("connection_failed", `SSH connection failed: ${message}`);
        }
        this.client = client;
        this.sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
            client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
        });
    }

    public async dispose(): Promise<void> {
        this.client?.end();
        this.client = undefined;
        this.sftp = undefined;
    }

    private channel(): SFTPWrapper {
        if (!this.sftp) throw new StorageError("connection_failed", "SFTP not connected");
        return this.sftp;
    }

    public async list(path: string, _options?: ListOptions): Promise<ListResult> {
        const rel = normalizeRelPath(path);
        const abs = this.resolve(rel);
        const sftp = this.channel();
        const items = await new Promise<Array<{ filename: string; attrs: Stats }>>((resolve, reject) => {
            sftp.readdir(abs, (error, list) =>
                error ? reject(new StorageError("not_found", `Cannot list ${path}`)) : resolve(list as never)
            );
        });
        const entries: StatEntry[] = items
            .filter((item) => item.filename !== "." && item.filename !== "..")
            .map((item) => toEntry(item.filename, rel === "" ? item.filename : `${rel}/${item.filename}`, item.attrs));
        entries.sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        return { entries };
    }

    public async stat(path: string): Promise<StatEntry> {
        const rel = normalizeRelPath(path);
        const sftp = this.channel();
        const attrs = await new Promise<Stats>((resolve, reject) => {
            sftp.stat(this.resolve(rel), (error, stats) =>
                error ? reject(new StorageError("not_found", `Not found: ${path}`)) : resolve(stats as never)
            );
        });
        return toEntry(baseName(rel) || rel, rel, attrs);
    }

    public async readStream(path: string, range?: ReadRange): Promise<ReadableStream<Uint8Array>> {
        const abs = this.resolve(normalizeRelPath(path));
        const options = range ? { start: range.start, end: range.end } : undefined;
        const nodeStream = this.channel().createReadStream(abs, options);
        return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    }

    public async writeStream(
        path: string,
        body: ReadableStream<Uint8Array>,
        options?: WriteOptions
    ): Promise<StatEntry> {
        const rel = normalizeRelPath(path);
        const abs = this.resolve(rel);
        await this.mkdirp(parentOf(rel));
        const writeOptions =
            options?.offset && options.offset > 0
                ? { flags: "r+" as const, start: options.offset }
                : { flags: "w" as const };
        const out = this.channel().createWriteStream(abs, writeOptions);
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
        const src = this.resolve(normalizeRelPath(from));
        const dst = this.resolve(normalizeRelPath(to));
        await this.mkdirp(parentOf(normalizeRelPath(to)));
        const sftp = this.channel();
        await new Promise<void>((resolve, reject) => {
            sftp.rename(src, dst, (error) =>
                error ? reject(new StorageError("io_error", `Failed to move ${from}`)) : resolve()
            );
        });
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
            await this.rmdir(this.resolve(rel));
        } else {
            await this.unlink(this.resolve(rel));
        }
    }

    public async usage(): Promise<StorageUsage> {
        // SFTP has no portable quota query; report nothing rather than guess.
        return {};
    }

    /** Create a directory and any missing parents (SFTP mkdir is not recursive). */
    private async mkdirp(rel: string): Promise<void> {
        if (rel === "") return;
        const segments = rel.split("/");
        let current = "";
        for (const segment of segments) {
            current = current === "" ? segment : `${current}/${segment}`;
            const abs = this.resolve(current);
            await new Promise<void>((resolve) => {
                this.channel().mkdir(abs, () => resolve());
            });
        }
    }

    private async rmdir(abs: string): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this.channel().rmdir(abs, (error) => (error ? reject(new StorageError("io_error", "rmdir failed")) : resolve()));
        });
    }

    private async unlink(abs: string): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this.channel().unlink(abs, (error) => (error ? reject(new StorageError("io_error", "delete failed")) : resolve()));
        });
    }
}

/** ssh2's per-entry attributes (a subset - the fields we use). */
interface Stats {
    size: number;
    mtime: number;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
}

function toEntry(name: string, path: string, attrs: Stats): StatEntry {
    return {
        name,
        path,
        kind: attrs.isDirectory() ? "dir" : attrs.isSymbolicLink() ? "symlink" : "file",
        size: BigInt(attrs.size ?? 0),
        modifiedAt: new Date((attrs.mtime ?? 0) * 1000)
    };
}

function parentOf(rel: string): string {
    const idx = rel.lastIndexOf("/");
    return idx < 0 ? "" : rel.slice(0, idx);
}
