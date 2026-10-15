/**
 * The uptime arithmetic behind the bars and the headline.
 */

import { describe, expect, it } from "vitest";
import {
    componentState,
    dayBars,
    dayTone,
    foldRun,
    pageState,
    uptimePercent
} from "@polaris-app/status-pages/src/model/uptime";

const now = new Date("2026-03-10T15:00:00Z");

describe("dayBars", () => {
    it("draws ninety days ending today, oldest first, with gaps as no data", () => {
        const bars = dayBars([{ day: "2026-03-10", total: 10, up: 10 }], now);
        expect(bars).toHaveLength(90);
        expect(bars[89]).toEqual({ day: "2026-03-10", tone: "ok", ratio: 1 });
        expect(bars[0]!.day).toBe("2025-12-11");
        expect(bars[0]!.tone).toBe("none");
    });

    it("sums the checks of a component on the same day", () => {
        const bars = dayBars(
            [
                { day: "2026-03-09", total: 100, up: 100 },
                { day: "2026-03-09", total: 100, up: 90 }
            ],
            now
        );
        expect(bars[88]).toEqual({ day: "2026-03-09", tone: "degraded", ratio: 0.95 });
    });

    it("ignores rollups outside the window", () => {
        const bars = dayBars([{ day: "2025-01-01", total: 5, up: 0 }], now);
        expect(bars.every((bar) => bar.tone === "none")).toBe(true);
    });
});

describe("dayTone", () => {
    it("reads a day from its share of up runs", () => {
        expect(dayTone(null)).toBe("none");
        expect(dayTone(1)).toBe("ok");
        expect(dayTone(0.9995)).toBe("ok");
        expect(dayTone(0.97)).toBe("degraded");
        expect(dayTone(0.5)).toBe("down");
    });
});

describe("uptimePercent", () => {
    it("weighs every run equally and rounds down to two decimals", () => {
        expect(
            uptimePercent([
                { day: "a", total: 2880, up: 2879 },
                { day: "b", total: 2880, up: 2880 }
            ])
        ).toBe(99.98);
    });

    it("has no figure without data", () => {
        expect(uptimePercent([])).toBeNull();
        expect(uptimePercent([{ day: "a", total: 0, up: 0 }])).toBeNull();
    });
});

describe("componentState and pageState", () => {
    it("derives a component from its checks", () => {
        expect(componentState([], false)).toBe("unknown");
        expect(componentState([null], false)).toBe("unknown");
        expect(componentState(["up", "up"], false)).toBe("operational");
        expect(componentState(["up", "down"], false)).toBe("degraded");
        expect(componentState(["down", "down"], false)).toBe("down");
        expect(componentState(["down"], true)).toBe("maintenance");
    });

    it("heads the page with its worst component", () => {
        expect(pageState([])).toBe("unknown");
        expect(pageState(["operational", "degraded"])).toBe("degraded");
        expect(pageState(["maintenance", "operational"])).toBe("maintenance");
        expect(pageState(["down", "maintenance"])).toBe("down");
    });
});

describe("foldRun", () => {
    it("counts every run and only the latency of the ones that answered", () => {
        let day = { total: 0, up: 0, latencySum: 0 };
        day = foldRun(day, true, 120);
        day = foldRun(day, false, 900);
        day = foldRun(day, true, null);
        expect(day).toEqual({ total: 3, up: 2, latencySum: 120 });
    });
});
