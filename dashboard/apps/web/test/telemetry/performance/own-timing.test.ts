/**
 * Polaris timing itself: its own page loads and reads, into its own project,
 * sampled in the browser and on the server so a busy dashboard stays cheap.
 * Asserted through the performance store, which is what would be written.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const recordTransaction = vi.fn(async () => {});

vi.mock("@/lib/telemetry/store", () => ({ captureEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/telemetry/performance-store", () => ({ recordTransaction }));
vi.mock("@/lib/telemetry/project-service", () => ({
    systemProject: vi.fn(async () => ({ id: "project-1", retentionDays: 30 }))
}));
vi.mock("@/lib/build-stamp", () => ({ buildStamp: () => "test" }));
vi.mock("@/lib/session", () => ({ backgroundUser: vi.fn(async () => ({ id: "user-1" })) }));

const capture = await import("@/lib/telemetry/capture");
const route = await import("../../../src/app/api/telemetry/page-load/route");
const { worthSending } = await import("@/components/telemetry/page-timing");

/** What was recorded, once the work nobody waited for has settled. */
async function recorded(): Promise<Record<string, unknown>[]> {
    await vi.waitFor(() => expect(recordTransaction).toHaveBeenCalled());
    return recordTransaction.mock.calls.map((call) => (call as unknown[])[1] as Record<string, unknown>);
}

function post(body: unknown, origin = "https://polaris.test"): Request {
    return new Request("https://polaris.test/api/telemetry/page-load", {
        method: "POST",
        headers: { origin, host: "polaris.test", "content-type": "application/json" },
        body: JSON.stringify(body)
    });
}

beforeEach(() => recordTransaction.mockClear());

describe("a page load Polaris measured", () => {
    it("is recorded as a page load judged by its LCP, its ids grouped", async () => {
        capture.measurePageLoad("/telemetry/0f1e2d3c4b5a69788796", { lcp: 3100, ttfb: 300, cls: 20 });
        const [reading] = await recorded();
        expect(reading).toMatchObject({
            name: "/telemetry/*",
            op: "pageload",
            durationMs: 3100,
            values: { duration: 3100, lcp: 3100, ttfb: 300, cls: 20 }
        });
    });

    it("is accepted from a signed-in page of this server and refused from another site", async () => {
        const accepted = await route.POST(post({ path: "/home", values: { lcp: 900 } }));
        expect(accepted.status).toBe(200);
        expect((await recorded())[0]).toMatchObject({ name: "/home", op: "pageload" });

        const foreign = await route.POST(post({ path: "/home", values: { lcp: 900 } }, "https://elsewhere.test"));
        expect(foreign.status).toBe(403);
    });

    it("refuses a body that is not a page load", async () => {
        for (const body of [
            { path: "https://elsewhere.test/", values: { lcp: 1 } },
            { path: "/home", values: {} },
            { path: "/home", values: { lcp: -1 } },
            { path: "/home", values: { lcp: 1, extra: 2 } }
        ]) {
            expect((await route.POST(post(body))).status).toBe(400);
        }
        expect(recordTransaction).not.toHaveBeenCalled();
    });
});

describe("which page loads the browser sends", () => {
    it("sends one in ten, and every load slower than a Web Vitals target", () => {
        expect(worthSending({ lcp: 900 }, 0.05)).toBe(true);
        expect(worthSending({ lcp: 900, inp: 120 }, 0.5)).toBe(false);
        expect(worthSending({ lcp: 2600 }, 0.5)).toBe(true);
        expect(worthSending({ inp: 250 }, 0.9)).toBe(true);
        expect(worthSending({}, 0)).toBe(false);
    });
});

describe("a read Polaris served", () => {
    it("is always timed when it is slow", async () => {
        capture.measureInternal("/api/telemetry/performance", 0, 1500);
        expect((await recorded())[0]).toMatchObject({ op: "http.server", durationMs: 1500, method: "GET" });
    });
});
