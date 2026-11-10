/**
 * A compressed crash report is read, not dropped: the Python SDK gzips every
 * request and the Node one gzips large ones, and the endpoint used to read the
 * bytes as text - every such report was lost without a trace.
 */

import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeIngestBody, readIngestBody } from "@/lib/telemetry/ingest-body";

const report = JSON.stringify({ event_id: "a".repeat(32), message: "boom" });
const MAX = 1_000_000;

describe("reading a report body", () => {
    it("reads plain, gzip, deflate and br bodies alike", () => {
        expect(decodeIngestBody(Buffer.from(report), null, MAX)).toBe(report);
        expect(decodeIngestBody(gzipSync(report), "gzip", MAX)).toBe(report);
        expect(decodeIngestBody(deflateSync(report), "deflate", MAX)).toBe(report);
        expect(decodeIngestBody(brotliCompressSync(report), "br", MAX)).toBe(report);
        expect(decodeIngestBody(gzipSync(report), "GZIP", MAX)).toBe(report);
    });

    it("undoes stacked encodings in reverse order", () => {
        expect(decodeIngestBody(gzipSync(deflateSync(report)), "deflate, gzip", MAX)).toBe(report);
    });

    it("refuses an empty, damaged, unknown or oversized body", () => {
        expect(decodeIngestBody(Buffer.alloc(0), null, MAX)).toBeNull();
        expect(decodeIngestBody(Buffer.from("not gzip"), "gzip", MAX)).toBeNull();
        expect(decodeIngestBody(Buffer.from(report), "zstd-from-the-future", MAX)).toBeNull();
        expect(decodeIngestBody(Buffer.from(report), null, 10)).toBeNull();
    });

    it("never inflates a small body past the bound", () => {
        const bomb = gzipSync(Buffer.alloc(5_000_000, 97));
        expect(bomb.length).toBeLessThan(MAX);
        expect(decodeIngestBody(bomb, "gzip", MAX)).toBeNull();
    });

    it("reads it straight off a request", async () => {
        const request = new Request("https://polaris.test/api/telemetry/api/1/store/", {
            method: "POST",
            headers: { "content-encoding": "gzip" },
            body: gzipSync(report)
        });
        expect(await readIngestBody(request, MAX)).toBe(report);
    });
});
