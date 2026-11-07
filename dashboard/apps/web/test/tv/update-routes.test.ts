/**
 * The update routes a TV calls: what is newest, the APK streamed with ranges, and
 * the progress report - each opened only by a TV's own key.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let principal: { keyId: string; userId: string; kind: string; scopes: string[] } | null = null;
let apk: Record<string, unknown> | null = null;
let failure: unknown = null;
let recorded = true;
const reports: unknown[] = [];
let dir = "";
const BYTES = Buffer.from("0123456789");

vi.mock("@/lib/api-key-auth", () => ({ authenticateApiKey: async () => principal }));
vi.mock("@/lib/api-usage/recorder", () => ({ withKeyUsage: (handler: unknown) => handler }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => ({ ok: true, retryAfterMs: 0 })
}));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));
vi.mock("@/lib/tv/release", async (original) => ({
    ...(await original<typeof import("@/lib/tv/release")>()),
    preparedTvApk: async () => {
        if (failure) throw failure;
        return apk;
    }
}));
vi.mock("@/lib/tv/update-requests", async (original) => ({
    ...(await original<typeof import("@/lib/tv/update-requests")>()),
    reportTvUpdate: async (keyId: string, report: unknown) => {
        reports.push({ keyId, report });
        return recorded;
    }
}));
vi.mock("@polaris/db", () => ({ prisma: {} }));

const { TvReleaseError } = await import("@/lib/tv/release");
const update = await import("@/app/api/tv/update/route");
const download = await import("@/app/api/tv/update/apk/route");
const report = await import("@/app/api/tv/update/report/route");

const ID = "0190a000-0000-7000-8000-000000000001";

function asked(path: string, init: RequestInit = {}): Request {
    return new Request(`https://polaris.example${path}`, {
        ...init,
        headers: { authorization: "Bearer key", ...(init.headers as Record<string, string>) }
    });
}

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tv-apk-"));
    await writeFile(join(dir, "polaris-tv.apk"), BYTES);
});
afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
    principal = { keyId: "key-1", userId: "user-1", kind: "tv", scopes: [] };
    apk = {
        versionName: "3.5",
        sha256: "a".repeat(64),
        apkUrl: "https://github.com/x",
        path: join(dir, "polaris-tv.apk"),
        size: BYTES.length
    };
    failure = null;
    recorded = true;
    reports.length = 0;
});

describe("GET /api/tv/update", () => {
    it("names the newest build and where to fetch it from this instance", async () => {
        const response = await update.GET(asked("/api/tv/update"));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            versionName: "3.5",
            versionCode: null,
            size: 10,
            sha256: "a".repeat(64),
            url: "/api/tv/update/apk?version=3.5"
        });
    });

    it("answers 204 when no TV build is released", async () => {
        apk = null;
        expect((await update.GET(asked("/api/tv/update"))).status).toBe(204);
    });

    it("refuses a build that did not match its checksum", async () => {
        failure = new TvReleaseError("mismatch");
        const response = await update.GET(asked("/api/tv/update"));
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({
            error: "errors.tvUpdateMismatch",
            reason: "mismatch"
        });
    });
});

describe("GET /api/tv/update/apk", () => {
    it("streams the whole file", async () => {
        const response = await download.GET(asked("/api/tv/update/apk?version=3.5"));
        expect(response.status).toBe(200);
        expect(response.headers.get("accept-ranges")).toBe("bytes");
        expect(response.headers.get("content-length")).toBe("10");
        expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES);
    });

    it("resumes from a range", async () => {
        const response = await download.GET(
            asked("/api/tv/update/apk?version=3.5", { headers: { range: "bytes=4-" } })
        );
        expect(response.status).toBe(206);
        expect(response.headers.get("content-range")).toBe("bytes 4-9/10");
        expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("456789");
    });

    it("sends the whole file when the range was for another build", async () => {
        const response = await download.GET(
            asked("/api/tv/update/apk", { headers: { range: "bytes=4-", "if-range": '"other"' } })
        );
        expect(response.status).toBe(200);
    });

    it("refuses a range past the end", async () => {
        const response = await download.GET(
            asked("/api/tv/update/apk", { headers: { range: "bytes=20-" } })
        );
        expect(response.status).toBe(416);
        expect(response.headers.get("content-range")).toBe("bytes */10");
    });

    it("says when the version asked for is no longer the newest", async () => {
        expect((await download.GET(asked("/api/tv/update/apk?version=3.4"))).status).toBe(409);
    });

    it("answers 503 when there is nothing to serve", async () => {
        failure = new TvReleaseError("unreachable");
        expect((await download.GET(asked("/api/tv/update/apk"))).status).toBe(503);
    });
});

describe("POST /api/tv/update/report", () => {
    function post(body: unknown): Request {
        return asked("/api/tv/update/report", { method: "POST", body: JSON.stringify(body) });
    }

    it("records a report against the TV's own key", async () => {
        const response = await report.POST(
            post({ id: ID, state: "failed", reason: "No space left" })
        );
        expect(response.status).toBe(204);
        expect(reports).toEqual([
            { keyId: "key-1", report: { id: ID, state: "failed", reason: "No space left" } }
        ]);
    });

    it("refuses a body that is not a report", async () => {
        expect((await report.POST(post({ id: ID, state: "queued" }))).status).toBe(400);
        expect(reports).toEqual([]);
    });

    it("answers 404 for a request that is not current", async () => {
        recorded = false;
        expect((await report.POST(post({ id: ID, state: "done" }))).status).toBe(404);
    });
});

describe("who may call them", () => {
    it.each(["key", "cli", "streamdeck"])("refuses a key of kind %s", async (kind) => {
        principal = { keyId: "key-1", userId: "user-1", kind, scopes: ["deploy.read"] };
        expect((await update.GET(asked("/api/tv/update"))).status).toBe(401);
        expect((await download.GET(asked("/api/tv/update/apk"))).status).toBe(401);
        expect((await report.POST(asked("/api/tv/update/report", { method: "POST" }))).status).toBe(
            401
        );
    });
});
