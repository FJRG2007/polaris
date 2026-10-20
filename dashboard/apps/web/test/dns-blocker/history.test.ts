import { describe, expect, it } from "vitest";
import { dayWindow, finishedDays, historyFrom, type DnsDayRow } from "@/lib/dns-blocker/history";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-18T12:00:00Z");

function row(day: string, queries: number, blocked: number, top: unknown = []): DnsDayRow {
    return {
        day: new Date(`${day}T00:00:00Z`),
        queries,
        blocked,
        clients: 1,
        hourly: [],
        topPermitted: top,
        topBlocked: [],
        topClients: [{ name: "10.0.0.2", count: queries, label: "tv.lan" }],
        topBlockedClients: [],
        blockedBy: []
    };
}

describe("long-term statistics", () => {
    it("looks back from yesterday, a whole UTC day an hour a bar", () => {
        expect(finishedDays(NOW, 2).map((day) => new Date(day).toISOString())).toEqual([
            "2026-10-17T00:00:00.000Z",
            "2026-10-16T00:00:00.000Z"
        ]);
        const window = dayWindow(Date.parse("2026-10-17T00:00:00Z"));
        expect((window.to - window.from) / window.bucketMs).toBe(24);
    });

    it("adds the range's days up, one bar a day ending yesterday", () => {
        const history = historyFrom(
            [
                row("2026-10-17", 100, 25, [{ name: "a.com", count: 10 }]),
                row("2026-10-16", 50, 5, [
                    { name: "a.com", count: 1 },
                    { name: "b.com", count: 20 }
                ]),
                // Out of a 30-day range, and today is never a row.
                row("2026-09-01", 999, 999),
                row("2026-10-18", 999, 999)
            ],
            "30d",
            NOW
        );
        expect(history).toMatchObject({ days: 30, queries: 150, blocked: 30, blockedPercent: 20 });
        expect(history.timeline.bucketMs).toBe(DAY);
        expect(history.timeline.allowed.slice(-2)).toEqual([45, 75]);
        expect(history.timeline.blocked.slice(-2)).toEqual([5, 25]);
        expect(history.topPermitted).toEqual([
            { name: "b.com", count: 20 },
            { name: "a.com", count: 11 }
        ]);
        expect(history.clientNames).toEqual([{ address: "10.0.0.2", name: "tv.lan" }]);
    });

    it("reads a malformed stored column as empty instead of failing the card", () => {
        const history = historyFrom([row("2026-10-17", 1, 0, "not a list")], "30d", NOW);
        expect(history.topPermitted).toEqual([]);
        expect(history.queries).toBe(1);
    });
});
