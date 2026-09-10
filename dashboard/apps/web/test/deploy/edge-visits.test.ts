/**
 * Who reached a service, read from the edge's own log - the one reader sleep mode
 * and the autoscaler share.
 *
 * The log here is a fake file's worth of Traefik's JSON lines, run through the
 * real parser: what is pinned is which lines count as somebody using the service
 * and which address they count toward.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { log } = vi.hoisted(() => ({ log: { text: "", truncated: false } }));

vi.mock("@/lib/edge-access-log", () => ({
    EDGE_LOG_RECENT_WINDOW_BYTES: 1024,
    readEdgeLogWindow: async () => ({ text: log.text, truncated: log.truncated })
}));
vi.mock("@/lib/deploy/quick-tunnel-service", () => ({
    tunnelHostForApp: (id: string) => `${id}.tunnel.test`
}));

const { readEdgeVisits, serviceHostnames, visitTimes } = await import("@/lib/deploy/edge-visits");

const NOW = Date.parse("2026-09-10T12:00:00Z");

/** One line as Traefik writes it. */
function line(
    secondsAgo: number,
    host: string | null,
    extra: Record<string, unknown> = {}
): string {
    return JSON.stringify({
        StartUTC: new Date(NOW - secondsAgo * 1000).toISOString(),
        RequestHost: host,
        RequestMethod: "GET",
        RequestPath: "/",
        DownstreamStatus: 200,
        "request_User-Agent": "Mozilla/5.0",
        ...extra
    });
}

beforeEach(() => {
    log.text = "";
    log.truncated = false;
});

describe("the edge's visits", () => {
    const shop = {
        id: "app-1",
        domains: [{ hostname: "Shop.Example.com" }, { hostname: "*.preview.example.com" }]
    };

    it("counts every request to any of a service's addresses", async () => {
        log.text = [
            line(50, "shop.example.com"),
            line(40, "SHOP.example.com:443"),
            line(30, "pr-7.preview.example.com"),
            line(20, "app-1.tunnel.test"),
            line(10, "other.example.com")
        ].join("\n");
        const times = visitTimes(await readEdgeVisits(), serviceHostnames(shop));
        expect(times).toEqual([NOW - 50_000, NOW - 40_000, NOW - 30_000, NOW - 20_000]);
    });

    it("leaves out Polaris's own probe and requests the firewall turned away", async () => {
        log.text = [
            line(30, "shop.example.com", { "request_User-Agent": "polaris-health-probe" }),
            line(20, "shop.example.com", { DownstreamStatus: 403 }),
            line(15, "shop.example.com", { DownstreamStatus: 429 }),
            line(10, "shop.example.com", { DownstreamStatus: 502 })
        ].join("\n");
        expect(visitTimes(await readEdgeVisits(), serviceHostnames(shop))).toEqual([NOW - 10_000]);
    });

    it("starts the window at the oldest request of any kind", async () => {
        log.text = [
            line(600, null),
            line(300, "other.example.com"),
            line(5, "shop.example.com")
        ].join("\n");
        const visits = await readEdgeVisits();
        expect(visits.windowStart).toBe(NOW - 600_000);
        expect(visitTimes(visits, serviceHostnames(shop))).toEqual([NOW - 5_000]);
    });

    it("knows nothing when there is no log", async () => {
        await expect(readEdgeVisits()).resolves.toEqual({
            visits: [],
            windowStart: null,
            truncated: false
        });
    });

    it("says when the window is short because the log holds more than was read", async () => {
        log.text = [line(3, "shop.example.com"), line(1, "shop.example.com")].join("\n");
        log.truncated = true;
        const visits = await readEdgeVisits();
        expect(visits.truncated).toBe(true);
        expect(visits.windowStart).toBe(NOW - 3_000);
    });
});
