/**
 * S3-compatible object storage: AWS S3 itself, and everything that speaks its
 * API - MinIO, Cloudflare R2, Backblaze B2, Wasabi, Ceph.
 *
 * Signing is delegated to aws4fetch rather than hand-rolled. SigV4 is the one
 * part of this file where a subtle mistake produces a driver that looks correct,
 * passes review, and rejects every request from a bucket nobody can test until
 * production - so it belongs in a small, single-purpose library that is verified
 * upstream. The requests themselves are plain REST and fail loudly when wrong.
 *
 * A bucket is not a filesystem, which shows up in three places. There are no
 * directories, so one is a zero-byte object with a trailing slash and a listing
 * asks for delimited common prefixes. There is no rename, so a move is a copy
 * and a delete. And there is no offset write, so a resumed upload restarts -
 * which is why `randomWrite` is declared false rather than quietly discarded.
 *
 * Listings are requested with `encoding-type=url` so a key containing an
 * ampersand or an angle bracket arrives percent-encoded instead of as XML that
 * has to be disambiguated.
 */

import { AwsClient } from "aws4fetch";
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

const S3_CAPABILITIES: StorageDriverCapabilities = {
    randomRead: true,
    // No offset writes: an interrupted upload is restarted, not resumed.
    randomWrite: false,
    // Copy-then-delete, not a native rename.
    move: false,
    // A bucket has no size to report; the account's billing does.
    usage: false,
    requiresHostd: false
};

/** What this driver ever sends as a body. Narrower than the platform's BodyInit,
 *  which is not a global under this package's lib settings. */
type S3Body = Uint8Array | string | null;

/** Part size for a multipart upload. S3's floor is 5 MiB for every part but the
 *  last; 8 MiB keeps the part count sane for large archives without holding much
 *  in memory. */
const PART_SIZE = 8 * 1024 * 1024;

/** Below this, an object is written with a single PUT. Above it, multipart -
 *  which is also the only way past S3's 5 GiB single-PUT ceiling. */
const SINGLE_PUT_LIMIT = PART_SIZE;

/** Attempts before a 5xx is treated as the destination being down. */
const RETRIES = 3;

export interface S3DriverOptions {
    readonly id: string;
    readonly bucket: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    /** Custom endpoint for a non-AWS implementation. Defaults to AWS in region. */
    readonly endpoint?: string;
    /** Address as `host/bucket/key` instead of `bucket.host/key`. MinIO and most
     *  self-hosted implementations need this. */
    readonly forcePathStyle?: boolean;
}

export class S3Driver implements StorageDriver {
    public readonly id: string;
    public readonly kind = "s3" as const;
    public readonly capabilities = S3_CAPABILITIES;
    private readonly bucket: string;
    private readonly client: AwsClient;
    private readonly origin: string;
    private readonly pathStyle: boolean;

    public constructor(options: S3DriverOptions) {
        this.id = options.id;
        this.bucket = options.bucket;
        this.pathStyle = options.forcePathStyle ?? false;
        this.origin = (options.endpoint ?? `https://s3.${options.region}.amazonaws.com`).replace(/\/+$/, "");
        this.client = new AwsClient({
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
            service: "s3",
            region: options.region,
            // The library retries 5xx ten times by default, doubling the wait
            // each time - close to a minute before it gives up. A backup writing
            // to several destinations would spend that minute stalled on the one
            // that is down instead of finishing the others and reporting it.
            retries: RETRIES
        });
    }

    /** Absolute URL for a key, honouring virtual-host vs path addressing. */
    private url(key: string, query?: Record<string, string | undefined>): string {
        const encodedKey = key.split("/").map(encodeURIComponent).join("/");
        const base = this.pathStyle
            ? `${this.origin}/${this.bucket}/${encodedKey}`
            : `${this.origin.replace("://", `://${this.bucket}.`)}/${encodedKey}`;
        const url = new URL(base);
        for (const [name, value] of Object.entries(query ?? {})) {
            if (value !== undefined) url.searchParams.set(name, value);
        }
        return url.toString();
    }

    /** Send a signed request, turning an error status into a StorageError. */
    private async send(
        method: string,
        url: string,
        init?: { headers?: Record<string, string>; body?: S3Body; expect?: number[] }
    ): Promise<Response> {
        let response: Response;
        try {
            response = await this.client.fetch(url, {
                method,
                headers: init?.headers,
                body: init?.body ?? null
            });
        } catch (error) {
            throw new StorageError("connection_failed", `S3 request failed: ${(error as Error).message}`);
        }
        const expected = init?.expect ?? [200, 204, 206];
        if (!expected.includes(response.status)) {
            throw await s3Error(response, method, url);
        }
        return response;
    }

    public async connect(): Promise<void> {
        // A delimited listing of nothing: the cheapest request that proves the
        // credentials sign correctly and the bucket exists and is readable.
        await this.send("GET", this.url("", { "list-type": "2", "max-keys": "1" }), { expect: [200] });
    }

    public async dispose(): Promise<void> {
        // Stateless: every request carries its own signature.
    }

    public async list(path: string, options?: ListOptions): Promise<ListResult> {
        const rel = normalizeRelPath(path);
        const prefix = rel === "" ? "" : `${rel}/`;
        const response = await this.send(
            "GET",
            this.url("", {
                "list-type": "2",
                prefix,
                delimiter: "/",
                "encoding-type": "url",
                "max-keys": String(options?.limit ?? 1000),
                "continuation-token": options?.cursor
            }),
            { expect: [200] }
        );
        const xml = await response.text();
        const entries: StatEntry[] = [];

        for (const raw of tagValues(xml, "Prefix", "CommonPrefixes")) {
            const decoded = decodeURIComponent(raw).replace(/\/$/, "");
            if (decoded === "" || decoded === rel) continue;
            entries.push({
                name: baseName(decoded),
                path: decoded,
                kind: "dir",
                size: 0n,
                modifiedAt: new Date(0)
            });
        }

        for (const block of blocks(xml, "Contents")) {
            const key = decodeURIComponent(tagValue(block, "Key") ?? "");
            // The prefix marker itself is the folder, not a file inside it.
            if (key === "" || key === prefix) continue;
            entries.push({
                name: baseName(key),
                path: key,
                kind: "file",
                size: BigInt(tagValue(block, "Size") ?? "0"),
                modifiedAt: new Date(tagValue(block, "LastModified") ?? 0),
                etag: tagValue(block, "ETag")?.replace(/^"|"$/g, "")
            });
        }

        const truncated = tagValue(xml, "IsTruncated") === "true";
        const next = tagValue(xml, "NextContinuationToken");
        return { entries, nextCursor: truncated && next ? decodeURIComponent(next) : undefined };
    }

    public async stat(path: string): Promise<StatEntry> {
        const rel = normalizeRelPath(path);
        if (rel === "") {
            return { name: "", path: "", kind: "dir", size: 0n, modifiedAt: new Date(0) };
        }
        let response: Response;
        try {
            response = await this.send("HEAD", this.url(rel), { expect: [200] });
        } catch (error) {
            // No object under that key. It may still be a prefix with children,
            // which is the only thing a "directory" is in a bucket.
            if (error instanceof StorageError && error.code === "not_found") {
                const listing = await this.list(rel, { limit: 1 });
                if (listing.entries.length > 0) {
                    return { name: baseName(rel), path: rel, kind: "dir", size: 0n, modifiedAt: new Date(0) };
                }
            }
            throw error;
        }
        return {
            name: baseName(rel),
            path: rel,
            kind: "file",
            size: BigInt(response.headers.get("content-length") ?? "0"),
            modifiedAt: new Date(response.headers.get("last-modified") ?? 0),
            etag: response.headers.get("etag")?.replace(/^"|"$/g, "") ?? undefined,
            mime: response.headers.get("content-type") ?? undefined
        };
    }

    public async readStream(path: string, range?: ReadRange): Promise<ReadableStream<Uint8Array>> {
        const headers = range
            ? { range: `bytes=${range.start}-${range.end !== undefined ? range.end : ""}` }
            : undefined;
        const response = await this.send("GET", this.url(normalizeRelPath(path)), {
            headers,
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
            throw new StorageError("not_supported", "S3 cannot resume a partial upload; restart it");
        }
        const rel = normalizeRelPath(path);
        const known = options?.size;
        // A size the caller vouches for and that fits: one request, no bookkeeping.
        if (known !== undefined && known <= BigInt(SINGLE_PUT_LIMIT)) {
            const bytes = new Uint8Array(await new Response(body).arrayBuffer());
            await this.send("PUT", this.url(rel), {
                headers: {
                    "content-length": String(bytes.byteLength),
                    ...(options?.mime ? { "content-type": options.mime } : {})
                },
                body: bytes,
                expect: [200]
            });
            return this.stat(rel);
        }
        await this.multipartUpload(rel, body, options?.mime);
        return this.stat(rel);
    }

    /**
     * Stream an object in parts.
     *
     * An aborted upload leaves parts nobody can see and S3 keeps billing for
     * them, so a failure aborts the upload explicitly rather than abandoning it.
     */
    private async multipartUpload(key: string, body: ReadableStream<Uint8Array>, mime?: string): Promise<void> {
        const started = await this.send("POST", this.url(key, { uploads: "" }), {
            headers: mime ? { "content-type": mime } : undefined,
            expect: [200]
        });
        const uploadId = tagValue(await started.text(), "UploadId");
        if (!uploadId) throw new StorageError("io_error", "S3 did not return an upload id");

        const tags: string[] = [];
        try {
            let index = 1;
            for await (const part of chunk(body, PART_SIZE)) {
                const response = await this.send(
                    "PUT",
                    this.url(key, { partNumber: String(index), uploadId }),
                    { headers: { "content-length": String(part.byteLength) }, body: part, expect: [200] }
                );
                const etag = response.headers.get("etag");
                if (!etag) throw new StorageError("io_error", `S3 did not return an ETag for part ${index}`);
                tags.push(`<Part><PartNumber>${index}</PartNumber><ETag>${etag}</ETag></Part>`);
                index += 1;
            }
            if (tags.length === 0) {
                // Nothing arrived. An empty object is still a legitimate result,
                // and it is cheaper to write it directly than to complete an
                // upload with no parts, which S3 rejects.
                await this.send("DELETE", this.url(key, { uploadId }), { expect: [204, 200] });
                await this.send("PUT", this.url(key), {
                    headers: { "content-length": "0" },
                    body: new Uint8Array(0),
                    expect: [200]
                });
                return;
            }
            const response = await this.send("POST", this.url(key, { uploadId }), {
                headers: { "content-type": "application/xml" },
                body: `<CompleteMultipartUpload>${tags.join("")}</CompleteMultipartUpload>`,
                expect: [200]
            });
            // S3 can answer 200 and then describe a failure in the body, which is
            // the one case where the status line is not the outcome.
            const completed = await response.text();
            if (/<Error>/.test(completed)) {
                throw new StorageError("io_error", tagValue(completed, "Message") ?? "S3 failed to complete the upload");
            }
        } catch (error) {
            await this.send("DELETE", this.url(key, { uploadId }), { expect: [204, 200, 404] }).catch(
                () => undefined
            );
            throw error;
        }
    }

    public async mkdir(path: string): Promise<void> {
        const rel = normalizeRelPath(path);
        if (rel === "") return;
        // A bucket has no directories. The zero-byte marker exists so an empty
        // folder somebody created is still there when they come back.
        await this.send("PUT", this.url(`${rel}/`), {
            headers: { "content-length": "0" },
            body: new Uint8Array(0),
            expect: [200]
        });
    }

    public async move(from: string, to: string): Promise<void> {
        const source = normalizeRelPath(from);
        const target = normalizeRelPath(to);
        await this.send("PUT", this.url(target), {
            headers: { "x-amz-copy-source": `/${this.bucket}/${source}` },
            expect: [200]
        });
        await this.delete(source);
    }

    public async delete(path: string, options?: { recursive?: boolean }): Promise<void> {
        const rel = normalizeRelPath(path);
        if (options?.recursive ?? true) {
            // Delete the subtree before the marker, so a failure halfway leaves
            // the folder visible rather than orphaning its contents.
            let cursor: string | undefined;
            do {
                const page = await this.list(rel, { cursor, limit: 1000 });
                for (const entry of page.entries) {
                    await this.delete(entry.path, { recursive: entry.kind === "dir" });
                }
                cursor = page.nextCursor;
            } while (cursor);
            await this.send("DELETE", this.url(`${rel}/`), { expect: [204, 200, 404] }).catch(() => undefined);
        }
        await this.send("DELETE", this.url(rel), { expect: [204, 200, 404] });
    }

    public async usage(): Promise<StorageUsage> {
        // Object storage reports no quota; totals belong to the bill, not the API.
        return {};
    }
}

/** Turn an error response into a StorageError, preferring S3's own message. */
async function s3Error(response: Response, method: string, url: string): Promise<StorageError> {
    const body = await response.text().catch(() => "");
    const message = tagValue(body, "Message") ?? `${method} ${new URL(url).pathname} failed`;
    if (response.status === 404) return new StorageError("not_found", message);
    if (response.status === 403) return new StorageError("permission_denied", message);
    if (response.status === 401) return new StorageError("permission_denied", message);
    return new StorageError("io_error", `S3 ${response.status}: ${message}`);
}

/**
 * Cut a stream into buffers of at most `size`.
 *
 * Yields exactly one buffer per part so at most one part is held at a time: a
 * 40 GB world archive costs 8 MB of memory, not 40 GB.
 */
async function* chunk(stream: ReadableStream<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
    const reader = stream.getReader();
    let held: Uint8Array[] = [];
    let heldBytes = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.byteLength === 0) continue;
            held.push(value);
            heldBytes += value.byteLength;
            while (heldBytes >= size) {
                const joined = concat(held, heldBytes);
                yield joined.subarray(0, size);
                const rest = joined.subarray(size);
                held = rest.byteLength > 0 ? [rest] : [];
                heldBytes = rest.byteLength;
            }
        }
        if (heldBytes > 0) yield concat(held, heldBytes);
    } finally {
        reader.releaseLock();
    }
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
    if (parts.length === 1) return parts[0] as Uint8Array;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.byteLength;
    }
    return out;
}

/**
 * The text of the first `<tag>` in a document, XML entities resolved.
 *
 * Deliberately a scanner for a handful of known, non-recursive elements rather
 * than an XML parser: these are S3's own fixed response shapes, and the listing
 * is requested URL-encoded so the values cannot contain markup.
 */
function tagValue(xml: string, tag: string): string | undefined {
    const open = xml.indexOf(`<${tag}>`);
    if (open < 0) return undefined;
    const close = xml.indexOf(`</${tag}>`, open);
    if (close < 0) return undefined;
    return unescapeXml(xml.slice(open + tag.length + 2, close));
}

/** Every `<outer>` element's body, for the repeated ones. */
function* blocks(xml: string, tag: string): Generator<string> {
    let at = 0;
    for (;;) {
        const open = xml.indexOf(`<${tag}>`, at);
        if (open < 0) return;
        const close = xml.indexOf(`</${tag}>`, open);
        if (close < 0) return;
        yield xml.slice(open + tag.length + 2, close);
        at = close + tag.length + 3;
    }
}

/** Every `<tag>` inside every `<outer>` element. */
function* tagValues(xml: string, tag: string, outer: string): Generator<string> {
    for (const block of blocks(xml, outer)) {
        const value = tagValue(block, tag);
        if (value !== undefined) yield value;
    }
}

function unescapeXml(value: string): string {
    return value
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
}
