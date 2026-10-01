/**
 * The Connectivity screen, drawn on the server the way its first paint is.
 *
 * Pinned: the chrome is there before any data (headings, the filters, the
 * column headers), with skeletons only where figures go; once the record is in,
 * the state, the uptime and the list read from it; and both languages draw.
 */

import { withMessages } from "../setup/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectivityReport } from "@/lib/connectivity/outage-tracker";

let report: ConnectivityReport | null = null;

vi.mock("@/components/use-live-resource", () => ({
    useLiveResource: () => ({
        data: report,
        loading: report === null,
        error: null,
        stale: null,
        refreshing: false,
        updatedAt: null,
        kept: false,
        refresh: () => undefined,
        replace: () => undefined
    })
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: () => undefined }),
    usePathname: () => "/watch/connectivity",
    useSearchParams: () => new URLSearchParams("kind=line")
}));
vi.mock("@/components/display-format", () => ({
    useDisplayFormat: () => ({
        weekStartsOn: 1,
        preferences: { timeZone: "UTC", language: "en-US" },
        date: (value: string | number) => new Date(value).toISOString().slice(0, 10),
        time: (value: string | number) => new Date(value).toISOString().slice(11, 16),
        dateTime: (value: string | number) => new Date(value).toISOString().slice(0, 16).replace("T", " "),
        number: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat("en-US", options).format(value)
    })
}));
vi.mock("@/app/(app)/watch/connectivity/actions", () => ({
    checkConnectivityAction: async () => ({}),
    setMergeGapAction: async () => ({ seconds: 60 })
}));

const { ConnectivityView } = await import("@/app/(app)/watch/connectivity/connectivity-view");

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

function sample(): ConnectivityReport {
    const outage = {
        id: "o1",
        kind: "line" as const,
        startedAt: iso(NOW - 3_600_000),
        endedAt: iso(NOW - 3_000_000),
        lastSeenAt: iso(NOW - 3_060_000),
        lastUpAt: iso(NOW - 3_700_000),
        detectedBy: "polaris.example.com",
        detail: "Timed out",
        firstBack: "internet",
        firstBackAt: iso(NOW - 3_100_000),
        closedBy: "recovered",
        blips: 2
    };
    return {
        now: iso(NOW),
        lastPass: { at: iso(NOW - 60_000), up: true },
        open: null,
        since: iso(NOW - 10 * 86_400_000),
        periods: (["24h", "7d", "30d", "90d"] as const).map((key) => ({
            key,
            from: NOW - 86_400_000,
            observedMs: 86_400_000,
            downMs: 600_000,
            count: 1,
            longestMs: 600_000,
            averageMs: 600_000,
            uptime: 1 - 600_000 / 86_400_000
        })),
        outages: [outage, { ...outage, id: "o2", kind: "dns", blips: 0 }],
        truncated: false,
        months: [],
        mergeGapSeconds: 60,
        watchIntervalMs: 600_000,
        closeWatchMs: 30_000,
        staleAfterMs: 1_320_000
    };
}

beforeEach(() => {
    report = null;
});

describe("the first paint", () => {
    it("draws the chrome with nothing loaded, and skeletons only where the figures go", () => {
        const html = renderToStaticMarkup(withMessages(<ConnectivityView />));
        for (const words of ["Connectivity", "Right now", "Availability", "Last 24 hours", "Downtime per day", "Outages", "Started", "Duration", "Merging blips"]) {
            expect(html).toContain(words);
        }
        expect(html).toContain("animate-pulse");
        expect(html).not.toContain("Could not load");
    });
});

describe("with the record in", () => {
    it("shows the state, the uptime and the outages the filters keep", () => {
        report = sample();
        const html = renderToStaticMarkup(withMessages(<ConnectivityView />));
        expect(html).toContain("Online");
        // Floored, never rounded up: 99.305...% is 99.30%.
        expect(html).toContain("99.30%");
        expect(html).toContain("10 min");
        // The address bar asks for the line only, so the DNS one is filtered out.
        expect(html).toContain("1 of 2");
        expect(html).toContain("2 blips merged");
        expect(html).toContain("Outages less than 1 min apart count as one.");
        // Every day of the heatmap is a named button.
        expect(html.match(/aria-pressed="false"/g)?.length).toBeGreaterThanOrEqual(90);
    });

    it("draws in Spanish", () => {
        report = sample();
        const html = renderToStaticMarkup(withMessages(<ConnectivityView />, "es-ES"));
        expect(html).toContain("Disponibilidad");
        expect(html).toContain("En línea");
        expect(html).toContain("Caída por día");
    });

    it("says how long an ongoing outage has lasted", () => {
        const base = sample();
        const open = { ...base.outages[0]!, endedAt: null, lastSeenAt: iso(NOW - 10_000), closedBy: null, firstBack: null };
        report = { ...base, open, outages: [open], lastPass: { at: iso(NOW - 10_000), up: false } };
        const html = renderToStaticMarkup(withMessages(<ConnectivityView />));
        expect(html).toContain("Offline");
        expect(html).toMatch(/Down for 1 h/);
        expect(html).toContain("Noticed at polaris.example.com: Timed out");
    });
});
