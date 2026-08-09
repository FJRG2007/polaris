/**
 * S3 driver against a stubbed transport.
 *
 * The point is the wire: which URL is built for path-style versus virtual-host
 * addressing, that a listing asks for URL-encoded keys and decodes them back,
 * and that a stream of unknown length becomes a multipart upload that is
 * completed rather than abandoned. None of that can be checked by types, and all
 * of it is what breaks a backup silently.
 */

import { S3Driver } from "../../src/drivers/s3.js";
import { StorageError } from "../../src/driver.js";
import { afterEach, describe, expect, it, vi } from "vitest";

interface Call {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: Uint8Array | null;
    /** The same bytes as text, for the XML payloads. */
    readonly text: string;
}

/** Replace global fetch with a scripted responder and record what was sent. */
function stubFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
        const request = input as Request;
        const headers: Record<string, string> = {};
        // aws4fetch hands us a signed Request; a direct call hands us a URL.
        const source = typeof request?.headers?.forEach === "function" ? request.headers : new Headers();
        source.forEach((value: string, key: string) => {
            headers[key] = value;
        });
        const body = request?.body ? await new Response(request.body).arrayBuffer() : null;
        const bytes = body ? new Uint8Array(body) : null;
        const call: Call = {
            method: request.method ?? init?.method ?? "GET",
            url: typeof input === "string" ? input : request.url,
            headers,
            body: bytes,
            text: bytes ? new TextDecoder().decode(bytes) : ""
        };
        calls.push(call);
        return handler(call);
    });
    return calls;
}

function driver(options?: { forcePathStyle?: boolean; endpoint?: string }) {
    return new S3Driver({
        id: "conn-1",
        bucket: "backups",
        region: "eu-west-1",
        accessKeyId: "AKIAEXAMPLE",
        secretAccessKey: "secret",
        endpoint: options?.endpoint,
        forcePathStyle: options?.forcePathStyle
    });
}

const LISTING = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>tok%2Fen</NextContinuationToken>
  <Contents>
    <Key>polaris%2Fdb%20%26%20more.gz</Key>
    <LastModified>2026-08-09T10:00:00.000Z</LastModified>
    <ETag>&quot;abc123&quot;</ETag>
    <Size>4096</Size>
  </Contents>
  <CommonPrefixes><Prefix>polaris%2Fworlds%2F</Prefix></CommonPrefixes>
</ListBucketResult>`;

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("S3 addressing", () => {
    it("puts the bucket in the host by default", async () => {
        const calls = stubFetch(() => new Response(LISTING, { status: 200 }));
        await driver().list("");
        expect(calls[0]?.url.startsWith("https://backups.s3.eu-west-1.amazonaws.com/")).toBe(true);
    });

    it("puts the bucket in the path when the endpoint needs it", async () => {
        const calls = stubFetch(() => new Response(LISTING, { status: 200 }));
        await driver({ forcePathStyle: true, endpoint: "https://minio.example:9000" }).list("");
        expect(calls[0]?.url.startsWith("https://minio.example:9000/backups/")).toBe(true);
    });
});

describe("listing", () => {
    it("asks for url-encoded keys and decodes them back", async () => {
        const calls = stubFetch(() => new Response(LISTING, { status: 200 }));
        const page = await driver().list("polaris");

        expect(calls[0]?.url).toContain("encoding-type=url");
        expect(calls[0]?.url).toContain("delimiter=%2F");
        // A key holding a space and an ampersand survives the round trip intact.
        const file = page.entries.find((entry) => entry.kind === "file");
        expect(file?.path).toBe("polaris/db & more.gz");
        expect(file?.size).toBe(4096n);
        expect(file?.etag).toBe("abc123");
        const dir = page.entries.find((entry) => entry.kind === "dir");
        expect(dir?.path).toBe("polaris/worlds");
    });

    it("carries the continuation token when there is more", async () => {
        stubFetch(() => new Response(LISTING, { status: 200 }));
        const page = await driver().list("");
        expect(page.nextCursor).toBe("tok/en");
    });

    it("stops paging when the listing is complete", async () => {
        stubFetch(() => new Response(LISTING.replace("true", "false"), { status: 200 }));
        const page = await driver().list("");
        expect(page.nextCursor).toBeUndefined();
    });
});

describe("writing", () => {
    it("sends a known small object in one request", async () => {
        const calls = stubFetch((call) =>
            call.method === "HEAD"
                ? new Response(null, { status: 200, headers: { "content-length": "3" } })
                : new Response("", { status: 200 })
        );
        const body = new Blob([new Uint8Array([1, 2, 3])]).stream();
        await driver().writeStream("a/b.gz", body, { size: 3n });

        const puts = calls.filter((call) => call.method === "PUT");
        expect(puts).toHaveLength(1);
        expect(puts[0]?.url).toContain("/a/b.gz");
        expect(puts[0]?.body).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("uploads a stream of unknown length as multipart and completes it", async () => {
        const calls = stubFetch((call) => {
            if (call.url.includes("uploads=")) {
                return new Response("<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>");
            }
            if (call.method === "PUT" && call.url.includes("partNumber")) {
                return new Response("", { status: 200, headers: { etag: '"part-etag"' } });
            }
            if (call.method === "HEAD") {
                return new Response(null, { status: 200, headers: { "content-length": "20971520" } });
            }
            return new Response("<CompleteMultipartUploadResult></CompleteMultipartUploadResult>", { status: 200 });
        });

        // 20 MiB with no declared size: more than one 8 MiB part.
        const chunk = new Uint8Array(20 * 1024 * 1024);
        await driver().writeStream("big.tar", new Blob([chunk]).stream());

        const parts = calls.filter((call) => call.url.includes("partNumber"));
        expect(parts).toHaveLength(3);
        expect(parts[0]?.body?.length).toBe(8 * 1024 * 1024);
        expect(parts[2]?.body?.length).toBe(4 * 1024 * 1024);
        const completed = calls.find((call) => call.method === "POST" && call.url.includes("uploadId"));
        expect(completed?.text).toContain("<PartNumber>3</PartNumber>");
    });

    it("aborts the upload when a part fails, rather than leaving it billing", async () => {
        const calls = stubFetch((call) => {
            if (call.url.includes("uploads=")) {
                return new Response("<X><UploadId>up-2</UploadId></X>");
            }
            if (call.url.includes("partNumber")) return new Response("nope", { status: 500 });
            return new Response("", { status: 204 });
        });

        await expect(
            driver().writeStream("big.tar", new Blob([new Uint8Array(9 * 1024 * 1024)]).stream())
        ).rejects.toBeInstanceOf(StorageError);

        const aborted = calls.find((call) => call.method === "DELETE" && call.url.includes("uploadId=up-2"));
        expect(aborted).toBeDefined();
    });

    it("refuses a resumed write instead of silently truncating", async () => {
        stubFetch(() => new Response("", { status: 200 }));
        await expect(
            driver().writeStream("a.gz", new Blob([new Uint8Array(1)]).stream(), { offset: 10, size: 1n })
        ).rejects.toMatchObject({ code: "not_supported" });
    });
});

describe("errors", () => {
    it("maps 404 to not_found and keeps S3's own message", async () => {
        stubFetch(
            () =>
                new Response("<Error><Message>The specified key does not exist.</Message></Error>", {
                    status: 404
                })
        );
        await expect(driver().stat("missing.gz")).rejects.toMatchObject({
            code: "not_found",
            message: expect.stringContaining("specified key does not exist")
        });
    });

    it("maps 403 to permission_denied", async () => {
        stubFetch(() => new Response("<Error><Message>Access Denied</Message></Error>", { status: 403 }));
        await expect(driver().list("")).rejects.toMatchObject({ code: "permission_denied" });
    });
});
