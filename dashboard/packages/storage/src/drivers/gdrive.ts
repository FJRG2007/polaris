/**
 * Google Drive, through a linked Google account.
 *
 * Drive addresses files by id, not by path: "backups/polaris/2026-08.gz" is not
 * a location, it is three lookups. So this keeps a small path-to-id cache and
 * resolves a segment at a time. The cache is per driver instance, which is per
 * operation - long enough to save the repeated walk inside one upload, short
 * enough that it cannot serve an id for a file somebody has since moved.
 *
 * The scope asked for is `drive.file`, which grants access only to files this
 * application created. That is deliberate: a backup destination has no business
 * reading somebody's whole Drive, and the narrower scope means a compromise here
 * cannot. It also means the root folder must be created rather than chosen, and
 * that a folder somebody moves in the Drive UI stays visible while one they
 * create by hand is not something this can ever see.
 *
 * Uploads are resumable and chunked at a multiple of 256 KiB, as the API
 * requires; 308 means keep going and 200/201 means done.
 */

import { baseName, normalizeRelPath, parentPath } from "@polaris/core";
import {
    chunked,
    cloudFetch,
    cloudJson,
    collect,
    rangeHeader,
    refuseIfFilled,
    type TokenSource
} from "./cloud-http.js";
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

const GDRIVE_CAPABILITIES: StorageDriverCapabilities = {
    randomRead: true,
    randomWrite: false,
    // A move is a parent swap, which Drive does natively.
    move: true,
    usage: true,
    requiresHostd: false
};

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
/** The API requires every chunk but the last to be a multiple of 256 KiB. */
const CHUNK = 8 * 1024 * 1024;
/** Under this, one request is cheaper than negotiating a session. */
const SIMPLE_UPLOAD_LIMIT = 5 * 1024 * 1024;
const FIELDS = "id,name,mimeType,size,modifiedTime,createdTime,md5Checksum";

interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    size?: string;
    modifiedTime?: string;
    createdTime?: string;
    md5Checksum?: string;
}

export interface GDriveDriverOptions {
    readonly id: string;
    readonly token: TokenSource;
    /** Folder every path is relative to. Created on first use when absent. */
    readonly rootFolderId?: string;
    readonly rootFolderName?: string;
    /** Called when the root folder is created, so the connection can record it
     *  and stop creating a new one on every operation. */
    readonly onRootResolved?: (folderId: string) => void | Promise<void>;
}

export class GDriveDriver implements StorageDriver {
    public readonly id: string;
    public readonly kind = "gdrive" as const;
    public readonly capabilities = GDRIVE_CAPABILITIES;
    private readonly token: TokenSource;
    private readonly rootName: string;
    private readonly onRootResolved?: (folderId: string) => void | Promise<void>;
    private rootId: string | undefined;
    /** Normalized path -> file id, for this driver's lifetime only. */
    private readonly ids = new Map<string, string>();

    public constructor(options: GDriveDriverOptions) {
        this.id = options.id;
        this.token = options.token;
        this.rootId = options.rootFolderId;
        this.rootName = options.rootFolderName ?? "Polaris";
        this.onRootResolved = options.onRootResolved;
    }

    public async connect(): Promise<void> {
        await this.root();
    }

    public async dispose(): Promise<void> {
        this.ids.clear();
    }

    /** The folder every path hangs off, created the first time it is needed. */
    private async root(): Promise<string> {
        if (this.rootId) return this.rootId;
        const created = await cloudJson<DriveFile>(this.token, "Google Drive", `${API}/files?fields=id`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: this.rootName, mimeType: FOLDER_MIME })
        });
        this.rootId = created.id;
        await this.onRootResolved?.(created.id);
        return created.id;
    }

    /** One child by name, or undefined. Names are escaped: an apostrophe in a
     *  file name would otherwise close the query's string literal. */
    private async child(parentId: string, name: string): Promise<DriveFile | undefined> {
        const query = `'${parentId}' in parents and name = '${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and trashed = false`;
        const url = `${API}/files?q=${encodeURIComponent(query)}&fields=${encodeURIComponent(`files(${FIELDS})`)}&pageSize=1`;
        const page = await cloudJson<{ files?: DriveFile[] }>(this.token, "Google Drive", url);
        return page.files?.[0];
    }

    /** Resolve a normalized path to a file id, walking a segment at a time. */
    private async idFor(rel: string): Promise<string> {
        if (rel === "") return this.root();
        const cached = this.ids.get(rel);
        if (cached) return cached;
        const parentId = await this.idFor(parentPath(rel));
        const found = await this.child(parentId, baseName(rel));
        if (!found) throw new StorageError("not_found", `Not found in Google Drive: ${rel}`);
        this.ids.set(rel, found.id);
        return found.id;
    }

    /** The same, creating any folder along the way that is missing. */
    private async ensureFolder(rel: string): Promise<string> {
        if (rel === "") return this.root();
        const cached = this.ids.get(rel);
        if (cached) return cached;
        const parentId = await this.ensureFolder(parentPath(rel));
        const name = baseName(rel);
        const existing = await this.child(parentId, name);
        if (existing) {
            this.ids.set(rel, existing.id);
            return existing.id;
        }
        const created = await cloudJson<DriveFile>(this.token, "Google Drive", `${API}/files?fields=id`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] })
        });
        this.ids.set(rel, created.id);
        return created.id;
    }

    public async list(path: string, options?: ListOptions): Promise<ListResult> {
        const rel = normalizeRelPath(path);
        const parentId = await this.idFor(rel);
        const query = `'${parentId}' in parents and trashed = false`;
        const cursor = options?.cursor ? `&pageToken=${encodeURIComponent(options.cursor)}` : "";
        const fields = encodeURIComponent(`nextPageToken,files(${FIELDS})`);
        const url = `${API}/files?q=${encodeURIComponent(query)}&fields=${fields}&pageSize=${options?.limit ?? 200}${cursor}`;
        const page = await cloudJson<{ files?: DriveFile[]; nextPageToken?: string }>(
            this.token,
            "Google Drive",
            url
        );
        const entries = (page.files ?? []).map((file) => {
            const childPath = rel === "" ? file.name : `${rel}/${file.name}`;
            this.ids.set(childPath, file.id);
            return toEntry(file, childPath);
        });
        return { entries, nextCursor: page.nextPageToken };
    }

    public async stat(path: string): Promise<StatEntry> {
        const rel = normalizeRelPath(path);
        if (rel === "") {
            return { name: "", path: "", kind: "dir", size: 0n, modifiedAt: new Date(0) };
        }
        const fileId = await this.idFor(rel);
        const file = await cloudJson<DriveFile>(
            this.token,
            "Google Drive",
            `${API}/files/${fileId}?fields=${encodeURIComponent(FIELDS)}`
        );
        return toEntry(file, rel);
    }

    public async readStream(path: string, range?: ReadRange): Promise<ReadableStream<Uint8Array>> {
        const fileId = await this.idFor(normalizeRelPath(path));
        const response = await cloudFetch(this.token, "Google Drive", `${API}/files/${fileId}?alt=media`, {
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
        const parentId = await this.ensureFolder(parentPath(rel));
        const name = baseName(rel);
        // Drive keeps two files of the same name in one folder quite happily, so
        // an overwrite has to find and replace the existing id rather than post
        // a second copy that only differs by upload time.
        const existing = await this.child(parentId, name);
        const known = options?.size;

        if (known !== undefined && known <= BigInt(SIMPLE_UPLOAD_LIMIT)) {
            const bytes = await collect(body);
            const file = existing
                ? await this.simpleUpdate(existing.id, bytes, options?.mime)
                : await this.simpleCreate(parentId, name, bytes, options?.mime);
            this.ids.set(rel, file.id);
            return toEntry(file, rel);
        }

        const file = await this.resumableUpload(existing?.id, parentId, name, body, known, options?.mime);
        this.ids.set(rel, file.id);
        return toEntry(file, rel);
    }

    /** Multipart create: metadata and bytes in one request. */
    private async simpleCreate(
        parentId: string,
        name: string,
        bytes: Uint8Array,
        mime?: string
    ): Promise<DriveFile> {
        const boundary = `polaris${Math.random().toString(36).slice(2)}`;
        const metadata = JSON.stringify({ name, parents: [parentId] });
        const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mime ?? "application/octet-stream"}\r\n\r\n`;
        const tail = `\r\n--${boundary}--\r\n`;
        const encoder = new TextEncoder();
        const payload = new Uint8Array(
            encoder.encode(head).byteLength + bytes.byteLength + encoder.encode(tail).byteLength
        );
        payload.set(encoder.encode(head), 0);
        payload.set(bytes, encoder.encode(head).byteLength);
        payload.set(encoder.encode(tail), encoder.encode(head).byteLength + bytes.byteLength);
        return cloudJson<DriveFile>(
            this.token,
            "Google Drive",
            `${UPLOAD}/files?uploadType=multipart&fields=${encodeURIComponent(FIELDS)}`,
            {
                method: "POST",
                headers: { "content-type": `multipart/related; boundary=${boundary}` },
                body: payload
            }
        );
    }

    /** Replace the content of a file that already exists. */
    private async simpleUpdate(fileId: string, bytes: Uint8Array, mime?: string): Promise<DriveFile> {
        return cloudJson<DriveFile>(
            this.token,
            "Google Drive",
            `${UPLOAD}/files/${fileId}?uploadType=media&fields=${encodeURIComponent(FIELDS)}`,
            {
                method: "PATCH",
                headers: { "content-type": mime ?? "application/octet-stream" },
                body: bytes
            }
        );
    }

    /**
     * Upload in chunks against a resumable session.
     *
     * The total is sent as `*` until the final chunk, because a backup stream's
     * length is not always known before it has been read. That is allowed, and
     * it is why the last chunk is held back until the stream ends: only then is
     * there a number to close the range with.
     */
    private async resumableUpload(
        fileId: string | undefined,
        parentId: string,
        name: string,
        body: ReadableStream<Uint8Array>,
        size: bigint | undefined,
        mime?: string
    ): Promise<DriveFile> {
        const metadata = fileId ? {} : { name, parents: [parentId] };
        const start = await cloudFetch(
            this.token,
            "Google Drive",
            fileId
                ? `${UPLOAD}/files/${fileId}?uploadType=resumable&fields=${encodeURIComponent(FIELDS)}`
                : `${UPLOAD}/files?uploadType=resumable&fields=${encodeURIComponent(FIELDS)}`,
            {
                method: fileId ? "PATCH" : "POST",
                headers: {
                    "content-type": "application/json; charset=UTF-8",
                    ...(mime ? { "x-upload-content-type": mime } : {}),
                    ...(size !== undefined ? { "x-upload-content-length": String(size) } : {})
                },
                body: JSON.stringify(metadata)
            }
        );
        const session = start.headers.get("location");
        if (!session) throw new StorageError("io_error", "Google Drive did not return an upload session");

        let offset = 0;
        let pending: Uint8Array | undefined;
        let finished: DriveFile | undefined;

        // One chunk behind, so the last one can be sent with the real total.
        for await (const piece of chunked(body, CHUNK)) {
            if (pending) {
                await this.putChunk(session, pending, offset, undefined);
                offset += pending.byteLength;
            }
            pending = piece;
        }
        const total = offset + (pending?.byteLength ?? 0);
        if (pending) {
            finished = await this.putChunk(session, pending, offset, total);
        } else {
            // Nothing came through: close an empty upload so the file still exists.
            finished = await this.putChunk(session, new Uint8Array(0), 0, 0);
        }
        if (!finished) throw new StorageError("io_error", "Google Drive did not complete the upload");
        return finished;
    }

    /**
     * One chunk. Returns the file when this was the last one.
     *
     * 308 is Drive saying "keep going" and is not an error, so it is expected
     * explicitly - left to the default handling it would be raised as one.
     */
    private async putChunk(
        session: string,
        bytes: Uint8Array,
        offset: number,
        total: number | undefined
    ): Promise<DriveFile | undefined> {
        const last = bytes.byteLength === 0 ? offset : offset + bytes.byteLength - 1;
        const range =
            total === 0
                ? "bytes */0"
                : `bytes ${offset}-${last}/${total !== undefined ? total : "*"}`;
        const response = await cloudFetch(this.token, "Google Drive", session, {
            method: "PUT",
            headers: { "content-range": range, "content-length": String(bytes.byteLength) },
            body: bytes,
            expect: [200, 201, 308]
        });
        if (response.status === 308) return undefined;
        return (await response.json()) as DriveFile;
    }

    public async mkdir(path: string): Promise<void> {
        await this.ensureFolder(normalizeRelPath(path));
    }

    public async move(from: string, to: string): Promise<void> {
        const source = normalizeRelPath(from);
        const target = normalizeRelPath(to);
        const fileId = await this.idFor(source);
        const oldParent = await this.idFor(parentPath(source));
        const newParent = await this.ensureFolder(parentPath(target));
        await cloudJson<DriveFile>(
            this.token,
            "Google Drive",
            `${API}/files/${fileId}?addParents=${newParent}&removeParents=${oldParent}&fields=id`,
            {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name: baseName(target) })
            }
        );
        this.ids.delete(source);
        this.ids.set(target, fileId);
    }

    public async delete(path: string, options?: { recursive?: boolean }): Promise<void> {
        const rel = normalizeRelPath(path);
        // Drive has no non-recursive delete, so "only if it is empty" is proved
        // before it is asked rather than passed to it.
        if (options?.recursive === false) await refuseIfFilled(() => this.list(rel), rel);
        const fileId = await this.idFor(rel);
        // Deleting a folder takes its contents with it, so recursion is Drive's
        // problem rather than a walk from here.
        await cloudFetch(this.token, "Google Drive", `${API}/files/${fileId}`, {
            method: "DELETE",
            expect: [200, 204]
        });
        this.ids.delete(rel);
    }

    public async usage(): Promise<StorageUsage> {
        const about = await cloudJson<{ storageQuota?: { limit?: string; usage?: string } }>(
            this.token,
            "Google Drive",
            `${API}/about?fields=storageQuota`
        );
        const limit = about.storageQuota?.limit;
        const used = about.storageQuota?.usage;
        // An unlimited account reports no limit at all rather than a large one.
        return {
            total: limit !== undefined ? BigInt(limit) : undefined,
            used: used !== undefined ? BigInt(used) : undefined,
            free: limit !== undefined && used !== undefined ? BigInt(limit) - BigInt(used) : undefined
        };
    }
}

function toEntry(file: DriveFile, path: string): StatEntry {
    return {
        name: file.name,
        path,
        kind: file.mimeType === FOLDER_MIME ? "dir" : "file",
        size: BigInt(file.size ?? "0"),
        modifiedAt: new Date(file.modifiedTime ?? 0),
        createdAt: file.createdTime ? new Date(file.createdTime) : undefined,
        etag: file.md5Checksum,
        mime: file.mimeType
    };
}
