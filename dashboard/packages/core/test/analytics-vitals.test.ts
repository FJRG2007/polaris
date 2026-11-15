import { describe, expect, it } from "vitest";
import { visitBeatSchema } from "../src/schemas/analytics";
import { webVitalBand, webVitalsSchema } from "../src/analytics-vitals";

describe("webVitalBand", () => {
    it("rates on Google's thresholds, boundaries included", () => {
        expect(webVitalBand("lcp", 2500)).toBe("good");
        expect(webVitalBand("lcp", 2501)).toBe("improve");
        expect(webVitalBand("lcp", 4001)).toBe("poor");
        expect(webVitalBand("inp", 200)).toBe("good");
        expect(webVitalBand("cls", 0.25)).toBe("improve");
        expect(webVitalBand("ttfb", 1801)).toBe("poor");
    });

    it("never calls a missing measurement good", () => {
        expect(webVitalBand("fcp", null)).toBe("unknown");
        expect(webVitalBand("fcp", Number.NaN)).toBe("unknown");
    });
});

describe("webVitalsSchema", () => {
    it("takes a partial set", () => {
        expect(webVitalsSchema.safeParse({ lcp: 1200 }).success).toBe(true);
    });

    it("refuses an empty set, unknown keys and broken clocks", () => {
        expect(webVitalsSchema.safeParse({}).success).toBe(false);
        expect(webVitalsSchema.safeParse({ lcp: 1, extra: 2 }).success).toBe(false);
        expect(webVitalsSchema.safeParse({ lcp: 600_000 }).success).toBe(false);
        expect(webVitalsSchema.safeParse({ cls: -1 }).success).toBe(false);
    });

    it("rides on a vitals beat", () => {
        const beat = visitBeatSchema.safeParse({ key: "abcdefgh12", type: "vitals", url: "/", vitals: { inp: 80 } });
        expect(beat.success).toBe(true);
    });
});
