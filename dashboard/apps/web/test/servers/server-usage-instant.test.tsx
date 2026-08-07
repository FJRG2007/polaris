/**
 * What a server's page shows where its CPU, memory and disk go, on the way in.
 *
 * Reading a server means an SSH session and a probe script on the far end, which
 * is a second or two on a good day. Opening the page used to spend that time on
 * skeletons - every time, including the tenth visit to the same machine - so the
 * figures the tab last read are painted first and the probe behind them only moves
 * the numbers.
 *
 * A kept reading is only worth painting if the panel says when it was taken, and
 * a machine that has stopped answering must not keep looking healthy behind its
 * last good numbers. Both are pinned here alongside the instant paint.
 *
 * Rendered to static markup: the assertion is the first paint, before the probe
 * that never resolves here could have answered.
 */

import { writeSnapshot } from "@/lib/snapshot-cache";
import { renderToStaticMarkup } from "react-dom/server";
import type { ServerMetrics } from "@/lib/server-probe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** sessionStorage as the cache expects it; jsdom is not loaded for these tests. */
class MemoryStorage {
    private readonly items = new Map<string, string>();
    public get length(): number {
        return this.items.size;
    }
    public key(index: number): string | null {
        return [...this.items.keys()][index] ?? null;
    }
    public getItem(key: string): string | null {
        return this.items.get(key) ?? null;
    }
    public setItem(key: string, value: string): void {
        this.items.set(key, value);
    }
    public removeItem(key: string): void {
        this.items.delete(key);
    }
    public clear(): void {
        this.items.clear();
    }
}

// The probe is a server action against a real machine. It is never reached in a
// static render, and stubbed so importing the module does not pull the server in.
vi.mock("../../src/app/(app)/apps/servers/actions", () => ({
    serverMetricsAction: async () => null
}));

const { ServerUsage } = await import("../../src/app/(app)/apps/servers/server-usage");

const metrics: ServerMetrics = {
    os: "Ubuntu 26.04 LTS",
    kernel: "6.14.0-generic",
    probedAt: "2026-08-07T17:00:00.000Z",
    loadAverage: 0.62,
    cpuCount: 16,
    memoryUsedBytes: 3_000_000_000,
    memoryTotalBytes: 31_000_000_000,
    diskUsedBytes: 67_000_000_000,
    diskTotalBytes: 98_000_000_000,
    consumers: [{ kind: "container", name: "polaris-web-110", cpuPercent: 8.6, memoryBytes: 309_000_000 }]
};

describe("A server's usage panel", () => {
    beforeEach(() => {
        vi.stubGlobal("sessionStorage", new MemoryStorage());
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("paints the last reading of this machine before the probe answers", () => {
        writeSnapshot("servers.usage.host-a", metrics);

        const markup = renderToStaticMarkup(<ServerUsage hostId="host-a" />);

        expect(markup).toContain("0.62 load of 16");
        expect(markup).toContain("2.8 GB of 29 GB");
        expect(markup).toContain("62 GB of 91 GB");
        expect(markup).toContain("polaris-web-110");
        // No skeleton anywhere: every figure on screen is a real one.
        expect(markup).not.toContain("animate-pulse");
    });

    it("says a reading has aged rather than letting it pass for this instant's", () => {
        writeSnapshot("servers.usage.host-a", metrics);
        vi.advanceTimersByTime(5 * 60_000);

        const markup = renderToStaticMarkup(<ServerUsage hostId="host-a" />);

        expect(markup).toContain("read 5m ago");
    });

    it("does not paint another machine's figures under this one", () => {
        writeSnapshot("servers.usage.host-a", metrics);

        const markup = renderToStaticMarkup(<ServerUsage hostId="host-b" />);

        expect(markup).not.toContain("polaris-web-110");
        expect(markup).toContain("animate-pulse");
    });

    // A first visit, a new tab, a browser that has never been here: the tab holds
    // nothing, so without this the panel opens on skeletons however recently the
    // server itself read the machine.
    it("paints what the server already read when the tab is holding nothing", () => {
        const markup = renderToStaticMarkup(
            <ServerUsage
                hostId="host-a"
                initial={{ at: Date.now() - 5 * 60_000, value: metrics }}
            />
        );

        expect(markup).toContain("0.62 load of 16");
        expect(markup).toContain("polaris-web-110");
        expect(markup).toContain("read 5m ago");
        expect(markup).not.toContain("animate-pulse");
    });

    it("prefers what the tab holds over the server's copy, being the newer of the two", () => {
        writeSnapshot("servers.usage.host-a", {
            ...metrics,
            consumers: [{ kind: "process", name: "postgres", cpuPercent: 1.2, memoryBytes: 174_000_000 }]
        });

        const markup = renderToStaticMarkup(
            <ServerUsage hostId="host-a" initial={{ at: Date.now() - 5 * 60_000, value: metrics }} />
        );

        expect(markup).toContain("postgres");
        expect(markup).not.toContain("polaris-web-110");
    });
});
