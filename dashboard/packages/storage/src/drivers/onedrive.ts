/**
 * OneDrive, through Microsoft Graph and somebody's linked Microsoft account.
 *
 * Graph addresses items by path, so unlike Drive this needs no id resolution:
 * `/me/drive/root:/a/b/c` is the item. Everything hangs off a folder of our own
 * so a destination cannot be pointed at the whole account by accident.
 *
 * Two constraints from the upload API drive the shape of writeStream, and both
 * are the kind that fail late rather than loudly:
 *
 *  - Every chunk but the last MUST be a multiple of 320 KiB. A size that is not
 *    is accepted chunk after chunk and then fails when the file is committed.
 *  - The PUT that sends a chunk must NOT carry an Authorization header. The
 *    upload URL is already pre-authorized, and adding the bearer token to it
 *    answers 401.
 *
 * Graph also needs the total size in the Content-Range of every chunk, so an
 * upload of unknown length cannot be streamed. The engine stages every artifact
 * before it replicates it, so the size is known; when it is not, this says so
 * rather than guessing.
 */

import { baseName, normalizeRelPath, parentPath } from "@polaris/core";
import { chunked, cloudFetch, cloudJson, collect, rangeHeader, type TokenSource } from "./cloud-http.js";
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

const ONEDRIVE_CAPABILITIES: StorageDriverCapabilities = {
    randomRead: true,
    randomWrite: false,
    move: true,
    usage: true,
    requiresHostd: false
};

const GRAPH = "https://graph.microsoft.com/v1.0";
/** 320 KiB is the API's block; 10 MiB of them is the documented sweet spot. */
const BLOCK = 327_680;
const CHUNK = BLOCK * 32;
/** Graph recommends a session for anything over 10 MiB (4 MiB is the simple cap). */
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;

interface DriveItem {
    id: string;
    name: string;
    size?: number;
    lastModifiedDateTime?: string;
    createdDateTime?: string;
    eTag?: string;
    folder?: { childCount?: number };
    file?: { mimeType?: string };
}

export interface OneDriveDriverOptions {
    readonly id: string;
    readonly token: TokenSource;
    /** Which drive on the account; the default drive when absent. */
    readonly driveId?: string;
    readonly rootFolderName?: string;
}

export class OneDriveDriver implements StorageDriver {
    public readonly id: string;
    public readonly kind = "onedrive" as const;
    public readonly capabilities = ONEDRIVE_CAPABILITIES;
    private readonly token: TokenSource;
    private readonly drive: string;
    private readonly rootName: string;

    public constructor(options: OneDriveDriverOptions) {
        this.id = options.id;
        this.token = options.token;
        this.drive = options.driveId ? `${GRAPH}/drives/${options.driveId}` : `${GRAPH}/me/drive`;
        this.rootName = (options.rootFolderName ?? "Polaris").replace(/^\/+|\/+$/g, "");
    }

    /** Everything is confined under the connection's own folder. */
    private full(rel: string): string {
        return rel === "" ? this.rootName : `${this.rootName}/${rel}`;
    }

    /** `.../root:/a/b` for an item, or `.../root` for the drive's own root. */
    private item(rel: string, suffix = ""): string {
        const path = this.full(rel);
        const encoded = path.split("/").map(encodeURIComponent).join("/");
        if (path === "") return `${this.drive}/root${suffix ? `:${suffix}` : ""}`;
        return `${this.drive}/root:/${encoded}:${suffix}`;
    }

    public async connect(): Promise<void> {
        await this.mkdir("");
    }

    public async dispose(): Promise<void> {
        // Stateless.
    }

    public async list(path: string, options?: ListOptions): Promise<ListResult> {
        const rel = normalizeRelPath(path);
        const url = options?.cursor ?? `${this.item(rel, "/children")}?$top=${options?.limit ?? 200}`;
        const page = await cloudJson<{ value?: DriveItem[]; "@odata.nextLink"?: string }>(
            this.token,
            "OneDrive",
            url
        );
        const entries = (page.value ?? []).map((entry) =>
            toEntry(entry, rel === "" ? entry.name : `${rel}/${entry.name}`)
        );
        return { entries, nextCursor: page["@odata.nextLink"] };
    }

    public async stat(path: string): Promise<StatEntry> {
        const rel = normalizeRelPath(path);
        const item = await cloudJson<DriveItem>(this.token, "OneDrive", this.item(rel));
        return toEntry(item, rel);
    }

    public async readStream(path: string, range?: ReadRange): Promise<ReadableStream<Uint8Array>> {
        const response = await cloudFetch(this.token, "OneDrive", this.item(normalizeRelPath(path), "/content"), {
            headers: rangeHeader(range),
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
        await this.mkdir(parentPath(rel));
        const known = options?.size;

        if (known !== undefined && known <= BigInt(SIMPLE_UPLOAD_LIMIT)) {
            const bytes = await collect(body);
            const item = await cloudJson<DriveItem>(this.token, "OneDrive", this.item(rel, "/content"), {
                method: "PUT",
                headers: { "content-type": options?.mime ?? "application/octet-stream" },
                body: bytes
            });
            return toEntry(item, rel);
        }
        if (known === undefined) {
            throw new StorageError(
                "not_supported",
                "OneDrive needs the total size before a large upload starts; stage the file first"
            );
        }
        const item = await this.sessionUpload(rel, body, known);
        return toEntry(item, rel);
    }

    /** Upload through a session, in blocks Graph will accept. */
    private async sessionUpload(rel: string, body: ReadableStream<Uint8Array>, size: bigint): Promise<DriveItem> {
        const session = await cloudJson<{ uploadUrl?: string }>(
            this.token,
            "OneDrive",
            this.item(rel, "/createUploadSession"),
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    item: { "@microsoft.graph.conflictBehavior": "replace", name: baseName(rel) }
                })
            }
        );
        const uploadUrl = session.uploadUrl;
        if (!uploadUrl) throw new StorageError("io_error", "OneDrive did not return an upload URL");

        const total = Number(size);
        let offset = 0;
        let done: DriveItem | undefined;
        try {
            for await (const piece of chunked(body, CHUNK)) {
                const end = offset + piece.byteLength - 1;
                // No Authorization here on purpose: the upload URL carries its
                // own, and a bearer token on top of it is answered with a 401.
                const response = await fetch(uploadUrl, {
                    method: "PUT",
                    headers: {
                        "content-length": String(piece.byteLength),
                        "content-range": `bytes ${offset}-${end}/${total}`
                    },
                    body: piece
                });
                if (response.status === 200 || response.status === 201) {
                    done = (await response.json()) as DriveItem;
                } else if (response.status !== 202) {
                    const detail = await response.text().catch(() => "");
                    throw new StorageError(
                        response.status === 403 || response.status === 401 ? "permission_denied" : "io_error",
                        `OneDrive ${response.status} uploading ${rel}: ${detail.slice(0, 300)}`
                    );
                }
                offset = end + 1;
            }
        } catch (error) {
            // Leaving a session open holds the partial bytes until it expires.
            await fetch(uploadUrl, { method: "DELETE" }).catch(() => undefined);
            throw error;
        }
        if (offset !== total) {
            await fetch(uploadUrl, { method: "DELETE" }).catch(() => undefined);
            throw new StorageError(
                "io_error",
                `OneDrive expected ${total} bytes for ${rel} but the source produced ${offset}`
            );
        }
        if (!done) throw new StorageError("io_error", `OneDrive did not commit ${rel}`);
        return done;
    }

    public async mkdir(path: string): Promise<void> {
        const rel = normalizeRelPath(path);
        // Walk down creating what is missing: Graph creates one level per call.
        const segments = this.full(rel).split("/").filter(Boolean);
        let walked = "";
        for (const segment of segments) {
            const parent = walked;
            walked = walked === "" ? segment : `${walked}/${segment}`;
            const parentUrl =
                parent === ""
                    ? `${this.drive}/root/children`
                    : `${this.drive}/root:/${parent.split("/").map(encodeURIComponent).join("/")}:/children`;
            try {
                await cloudJson<DriveItem>(this.token, "OneDrive", parentUrl, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        name: segment,
                        folder: {},
                        // Already there is the expected case, not a failure.
                        "@microsoft.graph.conflictBehavior": "fail"
                    })
                });
            } catch (error) {
                if (!(error instanceof StorageError) || error.code !== "already_exists") throw error;
            }
        }
    }

    public async move(from: string, to: string): Promise<void> {
        const source = normalizeRelPath(from);
        const target = normalizeRelPath(to);
        await this.mkdir(parentPath(target));
        const parent = this.full(parentPath(target));
        await cloudJson<DriveItem>(this.token, "OneDrive", this.item(source), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                name: baseName(target),
                parentReference: { path: `/drive/root:/${parent}` }
            })
        });
    }

    public async delete(path: string, _options?: { recursive?: boolean }): Promise<void> {
        await cloudFetch(this.token, "OneDrive", this.item(normalizeRelPath(path)), {
            method: "DELETE",
            expect: [200, 204]
        });
    }

    public async usage(): Promise<StorageUsage> {
        const drive = await cloudJson<{ quota?: { total?: number; used?: number; remaining?: number } }>(
            this.token,
            "OneDrive",
            this.drive
        );
        const quota = drive.quota;
        return {
            total: quota?.total !== undefined ? BigInt(quota.total) : undefined,
            used: quota?.used !== undefined ? BigInt(quota.used) : undefined,
            free: quota?.remaining !== undefined ? BigInt(quota.remaining) : undefined
        };
    }
}

function toEntry(item: DriveItem, path: string): StatEntry {
    return {
        name: item.name,
        path,
        kind: item.folder ? "dir" : "file",
        size: BigInt(item.size ?? 0),
        modifiedAt: new Date(item.lastModifiedDateTime ?? 0),
        createdAt: item.createdDateTime ? new Date(item.createdDateTime) : undefined,
        etag: item.eTag,
        mime: item.file?.mimeType
    };
}
