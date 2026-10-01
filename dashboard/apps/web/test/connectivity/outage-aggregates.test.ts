/**
 * How the record adds up: uptime per period, per-day downtime, the list's filters
 * and its export.
 */

import { describe, expect, it } from "vitest";
import * as rules from "@/lib/connectivity/outages";
import * as list from "@/lib/connectivity/outage-list";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const STALE = 22 * MINUTE;
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

const span = (startedAt: number, endedAt: number | null, lastSeenAt = endedAt ?? startedAt) => ({
    startedAt,
    endedAt,
    lastSeenAt
});

describe("a period's summary", () => {
    it("counts the outages inside it, their total, longest and average", () => {
        const summary = rules.summarizePeriod(
            [
                span(NOW - 2 * HOUR, NOW - 2 * HOUR + 10 * MINUTE),
                span(NOW - HOUR, NOW - HOUR + 20 * MINUTE)
            ],
            NOW,
            DAY,
            NOW - 30 * DAY,
            STALE
        );
        expect(summary).toMatchObject({
            count: 2,
            downMs: 30 * MINUTE,
            longestMs: 20 * MINUTE,
            averageMs: 15 * MINUTE
        });
        expect(summary.uptime).toBeCloseTo(1 - (30 * MINUTE) / DAY, 10);
    });

    it("counts only the part of an outage that falls inside the period", () => {
        const summary = rules.summarizePeriod(
            [span(NOW - DAY - HOUR, NOW - DAY + HOUR)],
            NOW,
            DAY,
            null,
            STALE
        );
        expect(summary.downMs).toBe(HOUR);
        expect(summary.count).toBe(1);
    });

    it("measures an ongoing outage to now while it is watched", () => {
        const summary = rules.summarizePeriod(
            [span(NOW - HOUR, null, NOW - MINUTE)],
            NOW,
            DAY,
            null,
            STALE
        );
        expect(summary.downMs).toBe(HOUR);
    });

    it("stops an ongoing outage at its last sighting once nobody is watching", () => {
        const summary = rules.summarizePeriod(
            [span(NOW - 5 * HOUR, null, NOW - 4 * HOUR)],
            NOW,
            DAY,
            null,
            STALE
        );
        expect(summary.downMs).toBe(HOUR);
    });

    it("does not claim uptime for the time before tracking began", () => {
        const since = NOW - 2 * DAY;
        const summary = rules.summarizePeriod([], NOW, 90 * DAY, since, STALE);
        expect(summary.observedMs).toBe(2 * DAY);
        expect(summary.uptime).toBe(1);
        expect(rules.summarizePeriod([], NOW, DAY, NOW, STALE).uptime).toBeNull();
    });
});

describe("downtime per day", () => {
    it("splits an outage across midnight between the two days it touched", () => {
        const midnight = Date.UTC(2026, 9, 10);
        const days = rules.dailyDowntime(
            [span(midnight - HOUR, midnight + 2 * HOUR)],
            NOW,
            3,
            STALE,
            "UTC"
        );
        expect(days.map((day) => day.day)).toEqual(["2026-10-08", "2026-10-09", "2026-10-10"]);
        expect(days.map((day) => day.downMs)).toEqual([0, HOUR, 2 * HOUR]);
        expect(days.map((day) => day.count)).toEqual([0, 1, 1]);
    });

    it("cuts days in the reader's zone", () => {
        // 23:30 UTC on the 9th is already the 10th in Madrid.
        const at = Date.UTC(2026, 9, 9, 23, 30);
        const days = rules.dailyDowntime(
            [span(at, at + 10 * MINUTE)],
            NOW,
            2,
            STALE,
            "Europe/Madrid"
        );
        expect(days.find((day) => day.downMs > 0)?.day).toBe("2026-10-10");
    });

    it("ends a day at the next midnight in the zone, 23 hours on when the clocks go forward", () => {
        const now = Date.UTC(2026, 2, 30, 12);
        const days = rules.dailyDowntime([], now, 2, STALE, "Europe/Madrid");
        expect(days[0]?.day).toBe("2026-03-29");
        expect(days[0]!.end - days[0]!.start).toBe(23 * HOUR);
        expect(days[0]?.end).toBe(days[1]?.start);
    });

    it("steps a day's shade by thresholds a reader can name", () => {
        expect([0, 4 * MINUTE, 20 * MINUTE, 2 * HOUR, 5 * HOUR].map(rules.dayStep)).toEqual([
            0, 1, 2, 3, 4
        ]);
    });
});

describe("durations in words", () => {
    const say: rules.SpanWords = (form, values) => `${form}:${Object.values(values).join(",")}`;
    it("uses the two largest units, and drops seconds past ten minutes", () => {
        expect(rules.formatSpan(45_000, say)).toBe("seconds:45");
        expect(rules.formatSpan(4 * MINUTE + 12_000, say)).toBe("minutesSeconds:4,12");
        expect(rules.formatSpan(14 * MINUTE + 12_000, say)).toBe("minutes:14");
        expect(rules.formatSpan(3 * HOUR + 5 * MINUTE, say)).toBe("hoursMinutes:3,5");
        expect(rules.formatSpan(2 * DAY + 4 * HOUR, say)).toBe("daysHours:2,4");
    });
});

describe("the merge gap setting", () => {
    it("falls back to a minute for anything it cannot use", () => {
        expect(rules.storedMergeGap(null)).toBe(60);
        expect(rules.storedMergeGap("abc")).toBe(60);
        expect(rules.storedMergeGap("-5")).toBe(60);
        expect(rules.storedMergeGap("99999")).toBe(60);
        expect(rules.storedMergeGap("0")).toBe(0);
        expect(rules.storedMergeGap("120")).toBe(120);
    });

    it("validates the same bounds the form and the action use", () => {
        expect(rules.mergeGapSchema.safeParse(0).success).toBe(true);
        expect(rules.mergeGapSchema.safeParse(3600).success).toBe(true);
        expect(rules.mergeGapSchema.safeParse(3601).success).toBe(false);
        expect(rules.mergeGapSchema.safeParse(1.5).success).toBe(false);
    });
});

const outage = (overrides: Partial<list.ListedOutage>): list.ListedOutage => ({
    id: "1",
    kind: "line",
    startedAt: new Date(NOW - HOUR).toISOString(),
    endedAt: new Date(NOW - HOUR + 5 * MINUTE).toISOString(),
    lastSeenAt: new Date(NOW - HOUR + 4 * MINUTE).toISOString(),
    detectedBy: "polaris.example.com",
    detail: "Timed out",
    firstBack: "polaris.example.com",
    closedBy: "recovered",
    blips: 0,
    ...overrides
});

describe("the list's filters", () => {
    const rows = [
        outage({ id: "a" }),
        outage({ id: "b", kind: "dns", endedAt: new Date(NOW - HOUR + 20 * MINUTE).toISOString() }),
        outage({
            id: "c",
            startedAt: new Date(NOW - 40 * DAY).toISOString(),
            endedAt: new Date(NOW - 40 * DAY + MINUTE).toISOString()
        })
    ];
    const ids = (filters: Partial<list.OutageFilters>) =>
        list
            .filterOutages(rows, { ...list.DEFAULT_FILTERS, ...filters }, NOW, STALE)
            .map((row) => row.id);

    it("compose: kind, period and length", () => {
        expect(ids({})).toEqual(["a", "b", "c"]);
        expect(ids({ range: "30d" })).toEqual(["a", "b"]);
        expect(ids({ kinds: ["dns"] })).toEqual(["b"]);
        expect(ids({ min: "10m" })).toEqual(["b"]);
        expect(ids({ kinds: ["line"], range: "7d" })).toEqual(["a"]);
    });

    it("a picked day keeps what touched it", () => {
        const start = NOW - 40 * DAY - HOUR;
        expect(ids({ day: { label: "x", start, end: start + DAY } })).toEqual(["c"]);
    });

    it("round-trip through the address bar, and ignore what they cannot read", () => {
        const filters: list.OutageFilters = {
            kinds: ["dns", "line"],
            range: "30d",
            min: "1h",
            day: null
        };
        const query = list.filtersToQuery(filters);
        expect(
            list.filtersFromQuery(
                (key) => query[key] ?? null,
                () => null
            )
        ).toEqual({ ...filters, kinds: ["line", "dns"] });
        expect(list.filtersToQuery(list.DEFAULT_FILTERS)).toEqual({});
        expect(
            list.filtersFromQuery(
                (key) => ({ kind: "bogus", range: "1y", min: "x", day: "nope" })[key] ?? null,
                () => null
            )
        ).toEqual(list.DEFAULT_FILTERS);
    });
});

describe("the export", () => {
    const words: list.CsvWords = {
        headers: {
            started: "Started",
            ended: "Ended",
            durationSeconds: "Duration (s)",
            kind: "Kind",
            detectedBy: "Noticed at",
            detail: "Detail",
            firstBack: "First back",
            closedBy: "How it ended"
        },
        kind: (kind) => kind.toUpperCase(),
        firstBack: (value) => value,
        closedBy: (value) => value ?? "",
        ongoing: "Ongoing"
    };

    it("writes what is listed, durations in seconds, and guards formula cells", () => {
        const csv = list.outagesCsv(
            [
                outage({ detail: "=HYPERLINK(1)" }),
                outage({ id: "2", endedAt: null, lastSeenAt: new Date(NOW).toISOString() })
            ],
            words,
            NOW,
            STALE
        );
        const lines = csv.trimEnd().split("\r\n");
        expect(lines[0]).toBe(
            "Started,Ended,Duration (s),Kind,Noticed at,Detail,First back,How it ended"
        );
        expect(lines[1]).toContain(",300,LINE,");
        expect(lines[1]).toContain("'=HYPERLINK(1)");
        expect(lines[2]).toContain(",Ongoing,3600,");
    });

    it("names the file for the span it covers", () => {
        expect(list.csvFileName([outage({})], list.DEFAULT_FILTERS)).toBe(
            "connectivity-outages-2026-10-10_2026-10-10.csv"
        );
        expect(
            list.csvFileName([], {
                ...list.DEFAULT_FILTERS,
                day: { label: "2026-10-01", start: 0, end: 1 }
            })
        ).toBe("connectivity-outages-2026-10-01.csv");
    });
});
