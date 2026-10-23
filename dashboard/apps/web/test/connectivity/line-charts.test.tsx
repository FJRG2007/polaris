/**
 * The line's card on Watch > Connectivity, drawn the way its first paint is:
 * skeletons where the charts go before anything arrives, the three charts and
 * the public IP history from a fixture, a sentence when the range is empty, and
 * no address history (or shortcut) for a shared view.
 */

import { withMessages } from "../setup/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as rules from "@/lib/connectivity/line-samples";
import type { LineReport } from "@/lib/connectivity/line-samples";

let report: LineReport | null = null;
let failed = false;

vi.mock("@/components/use-live-resource", () => ({
    useLiveResource: () => ({
        data: report,
        loading: report === null && !failed,
        error: failed ? "boom" : null,
        refresh: () => undefined,
        replace: () => undefined
    })
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock("@/components/display-format", () => ({
    useDisplayFormat: () => ({
        preferences: { timeZone: "UTC", language: "en-US" },
        date: (value: string | number) => new Date(value).toISOString().slice(0, 10),
        time: (value: string | number) => new Date(value).toISOString().slice(11, 16),
        dateTime: (value: string | number) =>
            new Date(value).toISOString().slice(0, 16).replace("T", " "),
        number: (value: number, options?: Intl.NumberFormatOptions) =>
            new Intl.NumberFormat("en-US", options).format(value)
    })
}));
vi.mock("@/app/(app)/automations/actions", () => ({
    createAutomationAction: async () => ({ ok: true, id: "a1" })
}));

const { LineCharts } = await import("@/app/(app)/watch/connectivity/line-charts");
const { sharedLineReport } = rules;

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);

function fixture(): LineReport {
    const sums = Array.from({ length: 120 }, (_, index) => ({
        at: NOW - index * 60_000,
        sum: rules.sumOfSample({
            up: index % 40 !== 0,
            dnsOk: true,
            latencyMs: index % 40 === 0 ? null : 12 + (index % 7),
            lossPct: index % 40 === 0 ? 100 : 0
        })
    }));
    return {
        range: "24h",
        from: NOW - 86_400_000,
        to: NOW,
        points: rules.lineSeries(sums, "24h", NOW),
        totals: rules.lineTotals(sums),
        now: { at: new Date(NOW).toISOString(), up: true, kind: null, since: null, publicIp: "203.0.113.5" },
        ipChanges: [
            { at: new Date(NOW - 3_600_000).toISOString(), previous: "198.51.100.7", current: "203.0.113.5" },
            { at: new Date(NOW - 86_400_000).toISOString(), previous: null, current: "198.51.100.7" }
        ]
    };
}

beforeEach(() => {
    report = null;
    failed = false;
});

describe("the line's card", () => {
    it("paints its chrome with skeletons before the measurements arrive", () => {
        const html = renderToStaticMarkup(withMessages(<LineCharts admin />));
        expect(html).toContain("Line quality");
        expect(html).toContain("90 days");
        expect(html).not.toContain("Packet loss");
    });

    it("draws latency, loss, uptime and the public IP history", () => {
        report = fixture();
        const html = renderToStaticMarkup(withMessages(<LineCharts admin />));
        for (const text of ["Latency", "Packet loss", "Uptime", "Online", "Public IP history"])
            expect(html).toContain(text);
        expect(html).toContain("198.51.100.7 -&gt; 203.0.113.5");
        expect(html).toContain("First seen: 198.51.100.7");
        expect(html).toContain("Tell me when it comes back");
    });

    it("says so when the range has no measurements", () => {
        report = { ...fixture(), points: rules.lineSeries([], "24h", NOW), totals: rules.lineTotals([]) };
        const html = renderToStaticMarkup(withMessages(<LineCharts admin />));
        expect(html).toContain("No measurements in this range yet");
    });

    it("says the load failed in words", () => {
        failed = true;
        const html = renderToStaticMarkup(withMessages(<LineCharts admin />));
        expect(html).toContain("could not be loaded");
    });

    it("shows a shared view no addresses and no shortcut", () => {
        report = sharedLineReport(fixture());
        const html = renderToStaticMarkup(withMessages(<LineCharts admin={false} />));
        expect(html).toContain("Latency");
        expect(html).not.toContain("203.0.113.5");
        expect(html).not.toContain("Tell me when it comes back");
    });

    it("draws in Spanish", () => {
        report = fixture();
        const html = renderToStaticMarkup(withMessages(<LineCharts admin />, "es-ES"));
        expect(html).toContain("Calidad de la línea");
        expect(html).toContain("Historial de IP");
    });
});
