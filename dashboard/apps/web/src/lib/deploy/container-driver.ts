/**
 * A read-mostly StorageDriver over a running container's filesystem, so a deployed
 * service shows up in Drive as an ordinary browsable folder. It wraps the host
 * daemon's allowlisted fs endpoints (the same ones the deploy Files panel uses):
 * `ls`/`stat` for listing, `cat` for download, and the fs-write endpoint for
 * upload. Mutating operations the daemon does not permit (mkdir/move/delete) are
 * reported as unsupported, and the driver declares itself non-seekable so the
 * download route never asks for a byte range it cannot serve.
 *
 * The driver lives in the app layer (not in @polaris/storage) because it needs the
 * privileged HostdClient transport, which the pure storage package must not import.
 */

import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { baseName } from "@polaris/core";
import { HostdClient } from "@polaris/hostd-client";
import {
    StorageError,
    type ListResult,
    type ReadRange,
    type StatEntry,
    type StorageDriver,
    type StorageDriverCapabilities,
    type StorageUsage,
    type WriteOptions
} from "@polaris/storage";

/** stat -c format: size (bytes), mtime (epoch seconds), type text, and the path
 *  back, so a listing can be mapped even when some entries fail to stat. */
const STAT_FORMAT = "%s\t%Y\t%F\t%n";
/** hostd caps fs argv at 32 entries; `stat -c FMT -- <paths>` spends 4 on the head. */
const STAT_BATCH = 28;

/** Turn a container-absolute path and an entry name into the child's abs path. */
function joinAbs(dir: string, name: string): string {
    return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** Map a Drive provider-relative path (no leading slash) to a container-absolute
 *  path. Rejects the shell-hostile bytes the daemon would refuse anyway. */
function toAbsolute(path: string): string {
    if (path.includes("\0") || path.includes("\n")) throw new StorageError("io_error", "Invalid path");
    const clean = path.replace(/^\/+/, "");
    return clean ? `/${clean}` : "/";
}

/** Classify a `stat %F` type string into the StatEntry kind. */
function kindFromType(type: string): StatEntry["kind"] {
    if (type.includes("directory")) return "dir";
    if (type.includes("symbolic")) return "symlink";
    return "file";
}

export class ContainerDriver implements StorageDriver {
    public readonly id: string;
    public readonly kind = "local" as const;
    public readonly capabilities: StorageDriverCapabilities = {
        randomRead: false,
        randomWrite: false,
        move: false,
        usage: false,
        requiresHostd: true
    };

    private readonly container: string;
    private readonly hostd = new HostdClient();

    public constructor(options: { id: string; container: string }) {
        this.id = options.id;
        this.container = options.container;
    }

    public async connect(): Promise<void> {
        // The container name is resolved and ownership-checked before construction;
        // there is no session to open.
    }

    public async dispose(): Promise<void> {
        // Stateless: each call is a one-shot hostd request.
    }

    public async list(path: string): Promise<ListResult> {
        const dir = toAbsolute(path);
        const names = (await this.readText(["ls", "-1Ap", "--", dir]))
            .split("\n")
            .map((line) => line.replace(/\/$/, "").trimEnd())
            .filter((name) => name.length > 0 && name !== "." && name !== "..");

        const abs = names.map((name) => joinAbs(dir, name));
        const stats = await this.statMany(abs);
        const base = path.replace(/^\/+|\/+$/g, "");

        const entries: StatEntry[] = names.map((name, index) => {
            const info = stats.get(abs[index] as string);
            return {
                name,
                path: base ? `${base}/${name}` : name,
                kind: info?.kind ?? "file",
                size: info?.size ?? 0n,
                modifiedAt: info?.modifiedAt ?? new Date(0)
            };
        });
        return { entries };
    }

    public async stat(path: string): Promise<StatEntry> {
        const abs = toAbsolute(path);
        const stats = await this.statMany([abs]);
        const info = stats.get(abs);
        if (!info) throw new StorageError("not_found", "No such file or directory");
        const rel = path.replace(/^\/+|\/+$/g, "");
        return {
            name: rel ? baseName(rel) : "",
            path: rel,
            kind: info.kind,
            size: info.size,
            modifiedAt: info.modifiedAt
        };
    }

    public async readStream(path: string, _range?: ReadRange): Promise<ReadableStream<Uint8Array>> {
        // Non-seekable: the fs allowlist has only `cat`, so a range is never
        // requested (the download route gates ranges on capabilities.randomRead).
        const stream = await this.hostd.fsRead(this.container, ["cat", "--", toAbsolute(path)]);
        return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
    }

    public async writeStream(path: string, body: ReadableStream<Uint8Array>, _options?: WriteOptions): Promise<StatEntry> {
        const buffer = Buffer.from(await new Response(body).arrayBuffer());
        await this.drain(await this.hostd.fsWrite(this.container, toAbsolute(path), buffer));
        return this.stat(path);
    }

    public async mkdir(): Promise<void> {
        throw new StorageError("not_supported", "Creating folders inside a container is not supported");
    }

    public async move(): Promise<void> {
        throw new StorageError("not_supported", "Moving files inside a container is not supported");
    }

    public async delete(): Promise<void> {
        throw new StorageError("not_supported", "Deleting files inside a container is not supported");
    }

    public async usage(): Promise<StorageUsage> {
        return {};
    }

    /** stat a batch of container-absolute paths, mapping each back by its own path. */
    private async statMany(paths: string[]): Promise<Map<string, { size: bigint; modifiedAt: Date; kind: StatEntry["kind"] }>> {
        const result = new Map<string, { size: bigint; modifiedAt: Date; kind: StatEntry["kind"] }>();
        for (let i = 0; i < paths.length; i += STAT_BATCH) {
            const chunk = paths.slice(i, i + STAT_BATCH);
            let text: string;
            try {
                text = await this.readText(["stat", "-c", STAT_FORMAT, "--", ...chunk]);
            } catch {
                continue; // A failed batch just leaves those entries with defaults.
            }
            for (const line of text.split("\n")) {
                if (!line.trim()) continue;
                const parts = line.split("\t");
                if (parts.length < 4) continue;
                const [sizeText, mtimeText, type] = parts;
                const name = parts.slice(3).join("\t");
                result.set(name, {
                    size: BigInt(Number.parseInt(sizeText ?? "0", 10) || 0),
                    modifiedAt: new Date((Number.parseInt(mtimeText ?? "0", 10) || 0) * 1000),
                    kind: kindFromType(type ?? "")
                });
            }
        }
        return result;
    }

    /** Run an allowlisted fs-read command and collect its stdout as UTF-8 text. */
    private async readText(argv: string[]): Promise<string> {
        const stream = await this.hostd.fsRead(this.container, argv);
        return this.collect(stream).then((buffer) => buffer.toString("utf8"));
    }

    private collect(stream: Readable): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("end", () => resolve(Buffer.concat(chunks)));
            stream.on("error", reject);
        });
    }

    /** Consume a response body to completion so the underlying request finishes. */
    private drain(stream: IncomingMessage): Promise<void> {
        return new Promise((resolve, reject) => {
            stream.on("data", () => undefined);
            stream.on("end", () => resolve());
            stream.on("error", reject);
        });
    }
}
