/**
 * The three linked-account drivers, against a stubbed transport.
 *
 * Each provider has one or two rules that are accepted request after request and
 * only rejected at the end, which is the worst possible failure for a backup:
 * hours of upload, then a commit that refuses. Those are what this covers.
 *
 *  - Google Drive: chunks are a multiple of 256 KiB, the total stays `*` until
 *    the final chunk, and 308 means continue rather than fail.
 *  - OneDrive: chunks are a multiple of 320 KiB, and the chunk PUT must carry no
 *    Authorization header - the upload URL is already authorized and a bearer
 *    token on top of it answers 401.
 *  - Dropbox: the argument header is ASCII-only, so a path with an accent has to
 *    be escaped, and session offsets must match the bytes already sent exactly.
 */

import { GDriveDriver } from "../../src/drivers/gdrive.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropboxDriver } from "../../src/drivers/dropbox.js";
import { OneDriveDriver } from "../../src/drivers/onedrive.js";

interface Call {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly size: number;
    readonly text: string;
}

function stubFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers ?? {}).forEach((value, key) => {
            headers[key] = value;
        });
        const raw = init?.body;
        const bytes =
            raw instanceof Uint8Array
                ? raw
                : typeof raw === "string"
                  ? new TextEncoder().encode(raw)
                  : new Uint8Array(0);
        const call: Call = {
            method: init?.method ?? "GET",
            url: String(input),
            headers,
            size: bytes.byteLength,
            text: new TextDecoder().decode(bytes)
        };
        calls.push(call);
        return handler(call);
    });
    return calls;
}

const token = async () => "access-token";

/** A body of exactly `bytes` bytes, as a stream. */
function stream(bytes: number): ReadableStream<Uint8Array> {
    return new Blob([new Uint8Array(bytes)]).stream();
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("Google Drive", () => {
    it("chunks a large upload at a multiple of 256 KiB and closes with the real total", async () => {
        const calls = stubFetch((call) => {
            if (call.url.includes("uploadType=resumable")) {
                return new Response("{}", { status: 200, headers: { location: "https://upload.test/session" } });
            }
            if (call.url === "https://upload.test/session") {
                // Everything but the last chunk is answered "keep going".
                const range = call.headers["content-range"] ?? "";
                if (range.endsWith("/*")) return new Response("", { status: 308 });
                return new Response(JSON.stringify({ id: "file-1", name: "big.tar", mimeType: "x" }), {
                    status: 200
                });
            }
            return new Response(JSON.stringify({ files: [{ id: "root-1", name: "Polaris" }] }));
        });

        const driver = new GDriveDriver({ id: "c1", token, rootFolderId: "root-1" });
        await driver.writeStream("big.tar", stream(20 * 1024 * 1024));

        const chunks = calls.filter((call) => call.url === "https://upload.test/session");
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks.slice(0, -1)) {
            expect(chunk.size % (256 * 1024)).toBe(0);
            // The length is unknown while the stream is still being read.
            expect(chunk.headers["content-range"]).toMatch(/\/\*$/);
        }
        expect(chunks.at(-1)?.headers["content-range"]).toBe(
            `bytes ${16 * 1024 * 1024}-${20 * 1024 * 1024 - 1}/${20 * 1024 * 1024}`
        );
    });

    it("escapes an apostrophe in a name instead of breaking its own query", async () => {
        const calls = stubFetch(() => new Response(JSON.stringify({ files: [] })));
        const driver = new GDriveDriver({ id: "c1", token, rootFolderId: "root-1" });
        await driver.list("").catch(() => undefined);
        await driver.stat("Nacho's world").catch(() => undefined);

        const query = calls.map((call) => decodeURIComponent(call.url)).find((url) => url.includes("Nacho"));
        expect(query).toContain("Nacho\\'s world");
    });
});

describe("OneDrive", () => {
    it("chunks at a multiple of 320 KiB", async () => {
        const calls = stubFetch((call) => {
            if (call.url.includes("createUploadSession")) {
                return new Response(JSON.stringify({ uploadUrl: "https://up.test/s" }));
            }
            if (call.url === "https://up.test/s") {
                const range = call.headers["content-range"] ?? "";
                const [, end, total] = /bytes \d+-(\d+)\/(\d+)/.exec(range) ?? [];
                return Number(end) + 1 >= Number(total)
                    ? new Response(JSON.stringify({ id: "i", name: "big.tar", size: 20971520 }), { status: 201 })
                    : new Response(JSON.stringify({}), { status: 202 });
            }
            return new Response(JSON.stringify({ id: "f", name: "Polaris", folder: {} }));
        });

        const driver = new OneDriveDriver({ id: "c2", token });
        await driver.writeStream("big.tar", stream(20 * 1024 * 1024), { size: BigInt(20 * 1024 * 1024) });

        const chunks = calls.filter((call) => call.url === "https://up.test/s");
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks.slice(0, -1)) expect(chunk.size % 327_680).toBe(0);
    });

    it("sends no Authorization header on the chunk PUT", async () => {
        const calls = stubFetch((call) => {
            if (call.url.includes("createUploadSession")) {
                return new Response(JSON.stringify({ uploadUrl: "https://up.test/s" }));
            }
            if (call.url === "https://up.test/s") {
                return new Response(JSON.stringify({ id: "i", name: "f", size: 1 }), { status: 201 });
            }
            return new Response(JSON.stringify({ id: "f", name: "Polaris", folder: {} }));
        });

        const driver = new OneDriveDriver({ id: "c2", token });
        await driver.writeStream("f", stream(5 * 1024 * 1024), { size: BigInt(5 * 1024 * 1024) });

        const put = calls.find((call) => call.url === "https://up.test/s");
        expect(put).toBeDefined();
        expect(put?.headers["authorization"]).toBeUndefined();
    });

    it("refuses a large upload of unknown length rather than guessing the total", async () => {
        stubFetch(() => new Response(JSON.stringify({ id: "f", name: "Polaris", folder: {} })));
        const driver = new OneDriveDriver({ id: "c2", token });
        await expect(driver.writeStream("f", stream(1024))).rejects.toMatchObject({
            code: "not_supported"
        });
    });
});

describe("Dropbox", () => {
    it("escapes non-ASCII in the argument header", async () => {
        const calls = stubFetch(() => new Response(new Uint8Array(0), { status: 200 }));
        const driver = new DropboxDriver({ id: "c3", token, rootPath: "/Polaris" });
        await driver.readStream("mundo-tonto-año/ñu.gz");

        const arg = calls[0]?.headers["dropbox-api-arg"] ?? "";
        // Only ASCII may travel in a header.
        expect(/^[\x00-\x7f]*$/.test(arg)).toBe(true);
        expect(arg).toContain("a\\u00f1o");
        expect(arg).toContain("\\u00f1u.gz");
    });

    it("appends session chunks at the offset already sent", async () => {
        const calls = stubFetch((call) => {
            if (call.url.endsWith("/upload_session/start")) {
                return new Response(JSON.stringify({ session_id: "s-1" }));
            }
            if (call.url.endsWith("/upload_session/finish")) {
                return new Response(JSON.stringify({ ".tag": "file", name: "big.tar", size: 20971520 }));
            }
            return new Response(JSON.stringify({}));
        });

        const driver = new DropboxDriver({ id: "c3", token });
        await driver.writeStream("big.tar", stream(20 * 1024 * 1024));

        const appends = calls.filter((call) => call.url.endsWith("append_v2"));
        const offsets = appends.map(
            (call) => (JSON.parse(call.headers["dropbox-api-arg"] ?? "{}") as { cursor: { offset: number } }).cursor.offset
        );
        // Sequential and exact: 0, then whatever was actually sent before it.
        expect(offsets[0]).toBe(0);
        let running = 0;
        appends.forEach((call, index) => {
            expect(offsets[index]).toBe(running);
            running += call.size;
        });
        const finish = calls.find((call) => call.url.endsWith("/upload_session/finish"));
        const arg = JSON.parse(finish?.headers["dropbox-api-arg"] ?? "{}") as {
            cursor: { offset: number };
            commit: { path: string };
        };
        expect(arg.cursor.offset).toBe(20 * 1024 * 1024);
        expect(arg.commit.path).toBe("/Polaris/big.tar");
    });
});

/**
 * "Only if it is empty" on a provider whose delete has no such mode.
 *
 * All three take a folder's contents with it and offer nothing else, so the flag
 * used to be ignored outright: a caller tidying up an empty directory could take
 * a file that had landed in it a second earlier. It is proved before the delete
 * is asked for now, and a folder with anything in it is a refusal.
 */
describe("deleting a folder only if it is empty", () => {
    it("refuses when Dropbox says there is something in it", async () => {
        const calls = stubFetch((call) => {
            if (call.url.endsWith("/files/list_folder")) {
                return new Response(
                    JSON.stringify({ entries: [{ ".tag": "file", name: "kept.png" }] })
                );
            }
            return new Response(JSON.stringify({}));
        });

        const driver = new DropboxDriver({ id: "c4", token });
        await expect(driver.delete("polaris/chat/room", { recursive: false })).rejects.toThrow(
            /not empty/i
        );
        expect(calls.some((call) => call.url.endsWith("/files/delete_v2"))).toBe(false);
    });

    it("goes ahead when it is empty", async () => {
        const calls = stubFetch((call) => {
            if (call.url.endsWith("/files/list_folder")) {
                return new Response(JSON.stringify({ entries: [] }));
            }
            return new Response(JSON.stringify({}));
        });

        const driver = new DropboxDriver({ id: "c5", token });
        await driver.delete("polaris/chat/room", { recursive: false });
        expect(calls.some((call) => call.url.endsWith("/files/delete_v2"))).toBe(true);
    });

    it("still takes everything when nobody asked it not to", async () => {
        const calls = stubFetch(() => new Response(JSON.stringify({})));
        const driver = new DropboxDriver({ id: "c6", token });
        await driver.delete("polaris/chat/room");
        // Nothing is listed: the provider's own recursive delete is the point.
        expect(calls.some((call) => call.url.endsWith("/files/list_folder"))).toBe(false);
        expect(calls.some((call) => call.url.endsWith("/files/delete_v2"))).toBe(true);
    });
});
