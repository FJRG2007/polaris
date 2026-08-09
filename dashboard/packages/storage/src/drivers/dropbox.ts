/**
 * Dropbox, through somebody's linked Dropbox account.
 *
 * Two hosts, and which one a call goes to is not negotiable: metadata operations
 * are JSON RPC against api.dropboxapi.com, while anything carrying bytes goes to
 * content.dropboxapi.com with its arguments in a `Dropbox-API-Arg` header and
 * the payload as the body.
 *
 * That header is ASCII-only. A path with an accent or an emoji in it - which a
 * backup named after somebody's world will have sooner or later - has to be
 * escaped to \uXXXX or Dropbox rejects the request.
 *
 * Above 150 MB a single upload is refused, so anything that could be larger goes
 * through a session: start, append at an offset that must match exactly what has
 * been sent, then finish with the commit. Chunks are a multiple of 4 MiB, as
 * recommended, and sequential - a mismatched offset is an error, not a reorder.
 */

import { baseName, normalizeRelPath, parentPath } from "@polaris/core";
import { chunked, cloudFetch, cloudJson, collect, type TokenSource } from "./cloud-http.js";
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

const DROPBOX_CAPABILITIES: StorageDriverCapabilities = {
    randomRead: true,
    randomWrite: false,
    move: true,
    usage: true,
    requiresHostd: false
};

const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";
/** A multiple of the recommended 4 MiB block, well under the 150 MB ceiling. */
const CHUNK = 8 * 1024 * 1024;
/** Dropbox refuses a single upload above 150 MB; stay clear of the edge. */
const SIMPLE_UPLOAD_LIMIT = 140 * 1024 * 1024;

interface DropboxEntry {
    ".tag"?: "file" | "folder" | "deleted";
    name: string;
    path_lower?: string;
    path_display?: string;
    size?: number;
    server_modified?: string;
    client_modified?: string;
    content_hash?: string;
}

export interface DropboxDriverOptions {
    readonly id: string;
    readonly token: TokenSource;
    /** Folder every path is relative to, e.g. "/Polaris". */
    readonly rootPath?: string;
}

export class DropboxDriver implements StorageDriver {
    public readonly id: string;
    public readonly kind = "dropbox" as const;
    public readonly capabilities = DROPBOX_CAPABILITIES;
    private readonly token: TokenSource;
    private readonly root: string;

    public constructor(options: DropboxDriverOptions) {
        this.id = options.id;
        this.token = options.token;
        const trimmed = (options.rootPath ?? "/Polaris").replace(/\/+$/, "");
        this.root = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    }

    /** Absolute Dropbox path for a driver-relative one. The account root is "". */
    private at(rel: string): string {
        return rel === "" ? this.root : `${this.root}/${rel}`;
    }

    /** A JSON RPC call on the API host. */
    private async rpc<T>(endpoint: string, body: unknown): Promise<T> {
        return cloudJson<T>(this.token, "Dropbox", `${API}${endpoint}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
        });
    }

    public async connect(): Promise<void> {
        await this.mkdir("");
    }

    public async dispose(): Promise<void> {
        // Stateless.
    }

    public async list(path: string, options?: ListOptions): Promise<ListResult> {
        const rel = normalizeRelPath(path);
        const page = options?.cursor
            ? await this.rpc<{ entries?: DropboxEntry[]; cursor?: string; has_more?: boolean }>(
                  "/files/list_folder/continue",
                  { cursor: options.cursor }
              )
            : await this.rpc<{ entries?: DropboxEntry[]; cursor?: string; has_more?: boolean }>(
                  "/files/list_folder",
                  { path: this.at(rel), recursive: false, limit: options?.limit ?? 500 }
              );
        const entries = (page.entries ?? []).map((entry) =>
            toEntry(entry, rel === "" ? entry.name : `${rel}/${entry.name}`)
        );
        return { entries, nextCursor: page.has_more ? page.cursor : undefined };
    }

    public async stat(path: string): Promise<StatEntry> {
        const rel = normalizeRelPath(path);
        if (rel === "") {
            return { name: baseName(this.root), path: "", kind: "dir", size: 0n, modifiedAt: new Date(0) };
        }
        const entry = await this.rpc<DropboxEntry>("/files/get_metadata", { path: this.at(rel) });
        return toEntry(entry, rel);
    }

    public async readStream(path: string, range?: ReadRange): Promise<ReadableStream<Uint8Array>> {
        const response = await cloudFetch(this.token, "Dropbox", `${CONTENT}/files/download`, {
            method: "POST",
            headers: {
                "dropbox-api-arg": apiArg({ path: this.at(normalizeRelPath(path)) }),
                ...(range
                    ? { range: `bytes=${range.start}-${range.end !== undefined ? range.end : ""}` }
                    : {})
            },
            expect: [200, 206]
        });
        if (!response.body) throw new StorageError("io_error", `Empty response body for ${path}`);
        return response.body;
    }

    public async writeStream(
        path: string,
        body: ReadableStream<Uint8Array>,
        options?: WriteOptions
    ): Promise<StatEntry> {
        if (options?.offset && options.offset > 0) {
            throw new StorageError("not_supported", "Resuming a partial upload is not supported; restart it");
        }
        const rel = normalizeRelPath(path);
        const known = options?.size;

        if (known !== undefined && known <= BigInt(SIMPLE_UPLOAD_LIMIT)) {
            const bytes = await collect(body);
            const entry = await cloudJson<DropboxEntry>(this.token, "Dropbox", `${CONTENT}/files/upload`, {
                method: "POST",
                headers: {
                    "content-type": "application/octet-stream",
                    "dropbox-api-arg": apiArg({
                        path: this.at(rel),
                        mode: "overwrite",
                        autorename: false,
                        mute: true
                    })
                },
                body: bytes
            });
            return toEntry(entry, rel);
        }
        const entry = await this.sessionUpload(rel, body);
        return toEntry(entry, rel);
    }

    /**
     * Upload through a session.
     *
     * The session is started empty and every chunk is appended, which is what
     * Dropbox recommends: it keeps start and finish small enough to retry
     * cheaply, and the offset bookkeeping stays in one place.
     */
    private async sessionUpload(rel: string, body: ReadableStream<Uint8Array>): Promise<DropboxEntry> {
        const started = await cloudJson<{ session_id: string }>(
            this.token,
            "Dropbox",
            `${CONTENT}/files/upload_session/start`,
            {
                method: "POST",
                headers: {
                    "content-type": "application/octet-stream",
                    "dropbox-api-arg": apiArg({ close: false })
                },
                body: new Uint8Array(0)
            }
        );
        const sessionId = started.session_id;
        let offset = 0;
        for await (const piece of chunked(body, CHUNK)) {
            await cloudFetch(this.token, "Dropbox", `${CONTENT}/files/upload_session/append_v2`, {
                method: "POST",
                headers: {
                    "content-type": "application/octet-stream",
                    "dropbox-api-arg": apiArg({
                        cursor: { session_id: sessionId, offset },
                        close: false
                    })
                },
                body: piece
            });
            offset += piece.byteLength;
        }
        return cloudJson<DropboxEntry>(this.token, "Dropbox", `${CONTENT}/files/upload_session/finish`, {
            method: "POST",
            headers: {
                "content-type": "application/octet-stream",
                "dropbox-api-arg": apiArg({
                    cursor: { session_id: sessionId, offset },
                    commit: { path: this.at(rel), mode: "overwrite", autorename: false, mute: true }
                })
            },
            body: new Uint8Array(0)
        });
    }

    public async mkdir(path: string): Promise<void> {
        const rel = normalizeRelPath(path);
        try {
            // Dropbox creates the intermediate folders itself.
            await this.rpc<unknown>("/files/create_folder_v2", { path: this.at(rel), autorename: false });
        } catch (error) {
            // A folder that is already there is the expected case, and Dropbox
            // reports it as a conflict rather than as success.
            const conflict =
                error instanceof StorageError &&
                (error.code === "already_exists" || /conflict/i.test(error.message));
            if (!conflict) throw error;
        }
    }

    public async move(from: string, to: string): Promise<void> {
        const target = normalizeRelPath(to);
        await this.mkdir(parentPath(target));
        await this.rpc<unknown>("/files/move_v2", {
            from_path: this.at(normalizeRelPath(from)),
            to_path: this.at(target),
            autorename: false
        });
    }

    public async delete(path: string, _options?: { recursive?: boolean }): Promise<void> {
        // Deleting a folder takes its contents with it.
        await this.rpc<unknown>("/files/delete_v2", { path: this.at(normalizeRelPath(path)) });
    }

    public async usage(): Promise<StorageUsage> {
        const space = await this.rpc<{
            used?: number;
            allocation?: { allocated?: number; individual?: { allocated?: number } };
        }>("/users/get_space_usage", null);
        const allocated = space.allocation?.allocated ?? space.allocation?.individual?.allocated;
        const used = space.used;
        return {
            total: allocated !== undefined ? BigInt(allocated) : undefined,
            used: used !== undefined ? BigInt(used) : undefined,
            free:
                allocated !== undefined && used !== undefined ? BigInt(allocated) - BigInt(used) : undefined
        };
    }
}

/**
 * JSON for the `Dropbox-API-Arg` header.
 *
 * HTTP headers are ASCII, so every non-ASCII character is escaped to \uXXXX -
 * the form Dropbox documents for exactly this. Without it a path holding an
 * accent, a CJK character or an emoji is rejected before the upload starts.
 */
function apiArg(value: unknown): string {
    return JSON.stringify(value).replace(
        /[\u007f-\uffff]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
    );
}

function toEntry(entry: DropboxEntry, path: string): StatEntry {
    const modified = entry.server_modified ?? entry.client_modified;
    return {
        name: entry.name,
        path,
        kind: entry[".tag"] === "folder" ? "dir" : "file",
        size: BigInt(entry.size ?? 0),
        modifiedAt: new Date(modified ?? 0),
        etag: entry.content_hash
    };
}
