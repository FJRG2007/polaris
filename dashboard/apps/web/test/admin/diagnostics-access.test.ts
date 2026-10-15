/**
 * Diagnostics answers administrators only. A refused caller runs no check,
 * builds no bundle, spends no bandwidth and runs no fix - and what an
 * administrator sends is validated before anything runs.
 */

import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ADMIN = { id: "admin-1", isAdmin: true };
const apiAdmin = vi.fn(async (): Promise<unknown> => ADMIN);
const requireAdmin = vi.fn(async (): Promise<unknown> => ADMIN);
const runCheck = vi.fn(async (id: string) => ({ id, status: "pass", code: "ok", facts: {}, fix: null, ms: 1 }));
const bundleFiles = vi.fn(async () => ({ "manifest.json": "{}\n" }));
const bundleZip = vi.fn(async () => Buffer.from("zip"));
const rateLimit = vi.fn(async (): Promise<{ ok: boolean; retryAfterMs: number }> => ({ ok: true, retryAfterMs: 0 }));
const runSpeedTest = vi.fn(async () => ({ ok: true }));
const syncAppRoutes = vi.fn(async () => undefined);
const reclaimHostSpace = vi.fn(async () => undefined);

vi.mock("@/lib/api-session", () => ({ apiAdmin }));
vi.mock("@/lib/session", () => ({ requireAdmin }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit }));
vi.mock("@/lib/deploy-service", () => ({ syncAppRoutes }));
vi.mock("@/lib/deploy/host-space", () => ({ reclaimHostSpace }));
vi.mock("@/lib/diagnostics/speed-test", () => ({ runSpeedTest, lastSpeedResult: vi.fn(async () => null) }));
vi.mock("@/lib/diagnostics/checks", async (original) => ({
    ...(await original<typeof import("@/lib/diagnostics/checks")>()),
    runCheck
}));
vi.mock("@/lib/diagnostics/support-bundle", async (original) => ({
    ...(await original<typeof import("@/lib/diagnostics/support-bundle")>()),
    bundleFiles,
    bundleZip
}));

const checkRoute = await import("../../src/app/api/admin/diagnostics/check/route");
const bundleRoute = await import("../../src/app/api/admin/diagnostics/bundle/route");
const actions = await import("../../src/app/(app)/admin/diagnostics/actions");

const get = (path: string) => new Request(`http://localhost${path}`);

const refusals = [
    ["signed out", 401],
    ["not an administrator", 403]
] as const;

/** What `requireAdmin` does to a non-admin: Next's redirect, which throws. */
const redirected = () => Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/home?denied=1;307;" });

beforeEach(() => {
    vi.clearAllMocks();
    apiAdmin.mockResolvedValue(ADMIN);
    requireAdmin.mockResolvedValue(ADMIN);
    rateLimit.mockResolvedValue({ ok: true, retryAfterMs: 0 });
});

describe("who may use diagnostics", () => {
    for (const [who, status] of refusals) {
        it(`refuses somebody ${who} at both endpoints, running nothing`, async () => {
            apiAdmin.mockResolvedValue(NextResponse.json({ error: who }, { status }));
            expect((await checkRoute.GET(get("/api/admin/diagnostics/check?id=disk"))).status).toBe(status);
            expect((await bundleRoute.GET(get("/api/admin/diagnostics/bundle"))).status).toBe(status);
            expect((await bundleRoute.GET(get("/api/admin/diagnostics/bundle?preview=1"))).status).toBe(status);
            expect(runCheck).not.toHaveBeenCalled();
            expect(bundleFiles).not.toHaveBeenCalled();
            expect(rateLimit).not.toHaveBeenCalled();
        });
    }

    it("refuses a non-admin the speed test and the fixes, before anything runs", async () => {
        requireAdmin.mockRejectedValue(redirected());
        await expect(actions.runSpeedTestAction()).rejects.toThrow("NEXT_REDIRECT");
        await expect(actions.runFixAction("republishRoutes")).rejects.toThrow("NEXT_REDIRECT");
        expect(runSpeedTest).not.toHaveBeenCalled();
        expect(syncAppRoutes).not.toHaveBeenCalled();
        expect(runCheck).not.toHaveBeenCalled();
    });

    it("refuses a non-admin the page itself", async () => {
        requireAdmin.mockRejectedValue(redirected());
        const page = await import("../../src/app/(app)/admin/diagnostics/page");
        await expect(page.default()).rejects.toThrow("NEXT_REDIRECT");
    });
});

describe("what an administrator sends", () => {
    it("runs a known check and refuses an unknown one", async () => {
        const ok = await checkRoute.GET(get("/api/admin/diagnostics/check?id=disk"));
        expect(ok.status).toBe(200);
        expect(runCheck).toHaveBeenCalledWith("disk");
        for (const query of ["", "?id=", "?id=__proto__", "?id=DISK", "?id=disk%00"]) {
            expect((await checkRoute.GET(get(`/api/admin/diagnostics/check${query}`))).status).toBe(400);
        }
        expect(runCheck).toHaveBeenCalledTimes(1);
    });

    it("runs only the fixes it knows, and re-checks after one", async () => {
        expect(await actions.runFixAction("rm -rf /")).toEqual({ ok: false });
        expect(await actions.runFixAction({ action: "republishRoutes" })).toEqual({ ok: false });
        expect(syncAppRoutes).not.toHaveBeenCalled();
        const outcome = await actions.runFixAction("republishRoutes");
        expect(syncAppRoutes).toHaveBeenCalledTimes(1);
        expect(runCheck).toHaveBeenCalledWith("edge");
        expect(outcome.ok).toBe(true);
    });

    it("rate limits the download per admin, and the preview builds nothing", async () => {
        const preview = await bundleRoute.GET(get("/api/admin/diagnostics/bundle?preview=1"));
        expect(preview.status).toBe(200);
        expect(bundleFiles).not.toHaveBeenCalled();
        expect(rateLimit).not.toHaveBeenCalled();

        const download = await bundleRoute.GET(get("/api/admin/diagnostics/bundle"));
        expect(download.status).toBe(200);
        expect(download.headers.get("content-type")).toBe("application/zip");
        expect(download.headers.get("content-disposition")).toMatch(/^attachment; filename="polaris-support-/);
        expect(rateLimit).toHaveBeenCalledWith("diagnostics:bundle:admin-1", expect.any(Number), expect.any(Number));

        rateLimit.mockResolvedValueOnce({ ok: false, retryAfterMs: 61_000 });
        const limited = await bundleRoute.GET(get("/api/admin/diagnostics/bundle"));
        expect(limited.status).toBe(429);
        expect(limited.headers.get("retry-after")).toBe("61");
        expect(bundleFiles).toHaveBeenCalledTimes(1);

        expect((await bundleRoute.GET(get("/api/admin/diagnostics/bundle?preview=yes"))).status).toBe(400);
    });

    it("shows withheld settings in the preview by name, never by value", async () => {
        process.env.POLARIS_DIAG_TEST_SECRET = "fixture-preview-secret-value";
        try {
            const body = await (await bundleRoute.GET(get("/api/admin/diagnostics/bundle?preview=1"))).text();
            expect(body).toContain("POLARIS_DIAG_TEST_SECRET");
            expect(body).not.toContain("fixture-preview-secret-value");
        } finally {
            delete process.env.POLARIS_DIAG_TEST_SECRET;
        }
    });
});
