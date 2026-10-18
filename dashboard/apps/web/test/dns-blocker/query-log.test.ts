import { describe, expect, it } from "vitest";
import {
    QUERY_LOG_ROWS,
    QueryLogReader,
    parseBlockingStatus,
    parseQueryLine,
    queryFilterSchema,
    queryLogPath
} from "@/lib/dns-blocker/query-log";

function line(client: string, domain: string, responseType: string): string {
    return [
        "2026-10-18 10:00:00",
        client,
        client,
        "3",
        "reason",
        `${domain}.`,
        "1.2.3.4",
        "NOERROR",
        responseType,
        "A",
        "x"
    ].join("\t");
}

describe("query log", () => {
    it("names one UTC day's file", () => {
        expect(queryLogPath(new Date("2026-10-18T23:59:00Z"))).toBe("/logs/2026-10-18_ALL.log");
    });

    it("parses a row and refuses a short line", () => {
        expect(parseQueryLine(line("10.0.0.2", "Ads.Example.com", "BLOCKED"))).toMatchObject({
            client: "10.0.0.2",
            domain: "ads.example.com",
            outcome: "blocked",
            type: "A",
            durationMs: 3
        });
        expect(parseQueryLine(line("10.0.0.2", "a.com", "REBIND"))?.outcome).toBe("blocked");
        expect(parseQueryLine(line("10.0.0.2", "a.com", "CACHED"))?.outcome).toBe("allowed");
        expect(parseQueryLine("garbage")).toBeNull();
        expect(parseQueryLine("")).toBeNull();
    });

    it("sums every line and keeps only matching rows, newest first", () => {
        const reader = new QueryLogReader(queryFilterSchema.parse({ outcome: "blocked" }));
        reader.add(line("10.0.0.2", "ads.com", "BLOCKED"));
        reader.add(line("10.0.0.2", "news.com", "RESOLVED"));
        reader.add(line("10.0.0.3", "track.com", "BLOCKED"));
        reader.add(line("10.0.0.3", "ads.com", "BLOCKED"));
        const stats = reader.stats();
        expect(stats).toMatchObject({ queries: 4, blocked: 3, blockedPercent: 75 });
        expect(stats.topBlocked[0]).toEqual({ name: "ads.com", count: 2 });
        expect(stats.clients).toEqual(["10.0.0.2", "10.0.0.3"]);
        expect(reader.newest().map((row) => row.domain)).toEqual([
            "ads.com",
            "track.com",
            "ads.com"
        ]);
    });

    it("filters by search and client, and bounds the rows", () => {
        const reader = new QueryLogReader(
            queryFilterSchema.parse({ search: " ADS ", client: "10.0.0.2" })
        );
        for (let i = 0; i < QUERY_LOG_ROWS * 3; i += 1)
            reader.add(line("10.0.0.2", `ads${i}.com`, "CACHED"));
        reader.add(line("10.0.0.3", "ads.com", "CACHED"));
        reader.add(line("10.0.0.2", "news.com", "CACHED"));
        const rows = reader.newest();
        expect(rows).toHaveLength(QUERY_LOG_ROWS);
        expect(rows[0]?.domain).toBe(`ads${QUERY_LOG_ROWS * 3 - 1}.com`);
        expect(new QueryLogReader(queryFilterSchema.parse({})).stats().blockedPercent).toBe(0);
    });

    it("reads the engine's blocking status sentence", () => {
        expect(parseBlockingStatus('level=info msg="blocking enabled"')).toEqual({
            enabled: true,
            secondsLeft: null
        });
        expect(parseBlockingStatus("blocking disabled for groups: 'ads', for 299 seconds")).toEqual(
            { enabled: false, secondsLeft: 299 }
        );
        expect(parseBlockingStatus("blocking disabled for groups: ads")).toEqual({
            enabled: false,
            secondsLeft: null
        });
    });
});
