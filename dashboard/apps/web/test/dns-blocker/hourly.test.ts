import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

import { hourlyFrom } from "@/lib/dns-blocker/insights";
import type { QueryStats } from "@/lib/dns-blocker/query-log";

/** A day of ten-minute bars: six to the hour. */
function stats(allowed: number[], blocked: number[]): QueryStats {
    return { timeline: { from: 0, bucketMs: 600_000, allowed, blocked } } as unknown as QueryStats;
}

describe("the Overview card's hours", () => {
    it("adds six ten-minute bars into each hour, oldest first", () => {
        const allowed = Array.from({ length: 144 }, (_, bar) => (bar < 6 ? 1 : 0));
        const blocked = Array.from({ length: 144 }, (_, bar) => (bar >= 138 ? 2 : 0));
        const hours = hourlyFrom(stats(allowed, blocked));
        expect(hours).toHaveLength(24);
        expect(hours[0]).toEqual({ allowed: 6, blocked: 0 });
        expect(hours[23]).toEqual({ allowed: 0, blocked: 12 });
    });

    it("keeps hour-sized bars as they are", () => {
        const hours = hourlyFrom({
            timeline: { from: 0, bucketMs: 3_600_000, allowed: [3, 4], blocked: [1, 0] }
        } as unknown as QueryStats);
        expect(hours).toEqual([
            { allowed: 3, blocked: 1 },
            { allowed: 4, blocked: 0 }
        ]);
    });
});
