import { describe, expect, it } from "vitest";
import {
    QUERY_LOG_ROWS,
    QueryLogReader,
    TAIL_ROWS,
    parseBlockingStatus,
    parseEngineMetrics,
    parseQueryLine,
    parseTail,
    pauseSchema,
    queryFilterSchema,
    queryLogPath,
    rangeWindow,
    lookupSchema,
    parseLookup,
    ruleFromLogSchema
} from "@/lib/dns-blocker/query-log";

const NOW = Date.parse("2026-10-18T12:00:00Z");

function line(
    client: string,
    domain: string,
    responseType: string,
    options: { time?: string; reason?: string; type?: string; name?: string } = {}
): string {
    return [
        options.time ?? "2026-10-18 10:00:00",
        client,
        options.name ?? client,
        "3",
        options.reason ?? "reason",
        `${domain}.`,
        "1.2.3.4",
        "NOERROR",
        responseType,
        options.type ?? "A",
        "x"
    ].join("\t");
}

function reader(filter: Partial<ReturnType<typeof queryFilterSchema.parse>> = {}) {
    const parsed = queryFilterSchema.parse(filter);
    return new QueryLogReader(parsed, rangeWindow(parsed.range, NOW));
}

describe("query log", () => {
    it("names one UTC day's file", () => {
        expect(queryLogPath(new Date("2026-10-18T23:59:00Z"))).toBe("/logs/2026-10-18_ALL.log");
    });

    it("leaves out names Polaris looked up from inside the engine's container", () => {
        expect(parseQueryLine(line("127.0.0.1", "example.com", "RESOLVED"))).toBeNull();
        expect(parseQueryLine(line("::1", "example.com", "RESOLVED"))).toBeNull();
        expect(parseQueryLine(line("10.0.0.127", "example.com", "RESOLVED"))).not.toBeNull();
    });

    it("parses a row, who answered it and what blocked it, and refuses a short line", () => {
        expect(
            parseQueryLine(
                line("10.0.0.2", "Ads.Example.com", "BLOCKED", { reason: "BLOCKED (ads)" })
            )
        ).toMatchObject({
            client: "10.0.0.2",
            clientName: "",
            domain: "ads.example.com",
            outcome: "blocked",
            type: "A",
            durationMs: 3,
            via: "blocked",
            list: "ads",
            at: Date.parse("2026-10-18T10:00:00Z")
        });
        expect(parseQueryLine(line("10.0.0.2", "a.com", "REBIND"))?.outcome).toBe("blocked");
        expect(
            parseQueryLine(
                line("10.0.0.2", "a.com", "RESOLVED", {
                    reason: "RESOLVED (https://1.1.1.1:443/dns-query)",
                    name: "laptop.lan"
                })
            )
        ).toMatchObject({ via: "https://1.1.1.1:443/dns-query", clientName: "laptop.lan" });
        expect(parseQueryLine(line("10.0.0.2", "a.com", "CACHED"))?.via).toBe("cache");
        expect(parseQueryLine(line("10.0.0.2", "nas.home", "CUSTOMDNS"))?.via).toBe("local");
        expect(parseQueryLine("too\tshort")).toBeNull();
    });

    it("ends the window on the next bar and covers the days it touches", () => {
        const day = rangeWindow("24h", NOW);
        expect(day.to).toBe(NOW + 10 * 60_000);
        expect(day.to - day.from).toBe(24 * 3_600_000);
        expect(day.days.map((d) => d.toISOString().slice(0, 10))).toEqual([
            "2026-10-17",
            "2026-10-18"
        ]);
        expect(rangeWindow("7d", NOW).days).toHaveLength(8);
    });

    it("sums the window into totals, ten-minute bars, types, upstreams and top lists", () => {
        const log = reader();
        log.add(line("10.0.0.2", "ads.example", "BLOCKED", { reason: "BLOCKED (ads)" }));
        log.add(line("10.0.0.2", "ok.example", "RESOLVED", { reason: "RESOLVED (1.1.1.1:53)" }));
        log.add(
            line("10.0.0.3", "ok.example", "CACHED", { type: "AAAA", time: "2026-10-18 10:05:00" })
        );
        // Outside the 24 hours: in no number.
        log.add(line("10.0.0.9", "old.example", "RESOLVED", { time: "2026-10-16 10:00:00" }));
        const stats = log.stats();
        expect(stats).toMatchObject({ queries: 3, blocked: 1, blockedPercent: 33.3 });
        expect(stats.timeline.allowed).toHaveLength(144);
        const bar = (Date.parse("2026-10-18T10:00:00Z") - stats.timeline.from) / 600_000;
        expect(stats.timeline.allowed[bar]).toBe(2);
        expect(stats.timeline.blocked[bar]).toBe(1);
        expect(stats.queryTypes).toEqual([
            { name: "A", count: 2 },
            { name: "AAAA", count: 1 }
        ]);
        expect(stats.destinations.map((item) => item.name).sort()).toEqual([
            "1.1.1.1:53",
            "blocked",
            "cache"
        ]);
        expect(stats.blockedBy).toEqual([{ name: "ads", count: 1 }]);
        expect(stats.topPermitted).toEqual([{ name: "ok.example", count: 2 }]);
        expect(stats.topBlocked).toEqual([{ name: "ads.example", count: 1 }]);
        expect(stats.topClients[0]).toEqual({ name: "10.0.0.2", count: 2 });
        expect(stats.topBlockedClients).toEqual([{ name: "10.0.0.2", count: 1 }]);
        expect(stats.clientSeries[0]?.client).toBe("10.0.0.2");
        expect(stats.clientSeries[0]?.counts[bar]).toBe(2);
    });

    it("leaves out Polaris's own check that blocking is on, in the log and every count", () => {
        const check = line("172.22.0.1", "blocking-check.polaris.invalid", "BLOCKED", {
            reason: "BLOCKED (polaris)"
        });
        expect(parseQueryLine(check)).toBeNull();
        const log = reader();
        log.add(check);
        log.add(line("10.0.0.2", "ads.example", "BLOCKED", { reason: "BLOCKED (ads)" }));
        const stats = log.stats();
        expect(stats).toMatchObject({ queries: 1, blocked: 1 });
        expect(stats.topBlockedClients).toEqual([{ name: "10.0.0.2", count: 1 }]);
        expect(stats.topBlocked).toEqual([{ name: "ads.example", count: 1 }]);
        expect(log.page(0).rows.map((row) => row.domain)).toEqual(["ads.example"]);
    });

    it("pages the matching rows newest first and says when there is an older page", () => {
        const log = reader({ outcome: "blocked" });
        for (let at = 0; at < QUERY_LOG_ROWS + 5; at += 1) {
            log.add(line("10.0.0.2", `n${at}.example`, "BLOCKED"));
            log.add(line("10.0.0.2", "ok.example", "RESOLVED"));
        }
        const page = log.page(0);
        expect(page.rows).toHaveLength(QUERY_LOG_ROWS);
        expect(page.rows[0]?.domain).toBe(`n${QUERY_LOG_ROWS + 4}.example`);
        expect(page.hasMore).toBe(true);
        const older = log.page(1);
        expect(older.rows).toHaveLength(5);
        expect(older.rows.at(-1)?.domain).toBe("n0.example");
        expect(older.hasMore).toBe(false);
    });

    it("filters by search, client and type", () => {
        const log = reader({ search: "ads", client: "10.0.0.3", type: "aaaa" });
        log.add(line("10.0.0.2", "ads.example", "BLOCKED", { type: "AAAA" }));
        log.add(line("10.0.0.3", "ads.example", "BLOCKED", { type: "AAAA" }));
        log.add(line("10.0.0.3", "ads.example", "BLOCKED"));
        expect(log.page(0).rows).toHaveLength(1);
    });

    it("reads the live tail newest first, dropping a cut first line", () => {
        const lines = [
            "cut\tline",
            line("10.0.0.2", "a.example", "RESOLVED"),
            line("10.0.0.2", "b.example", "BLOCKED"),
            ""
        ].join("\n");
        const all = queryFilterSchema.parse({});
        expect(parseTail(lines, false, all).map((row) => row.domain)).toEqual([
            "b.example",
            "a.example"
        ]);
        expect(parseTail(lines, false, { ...all, outcome: "blocked" })).toHaveLength(1);
        const many = Array.from({ length: TAIL_ROWS + 10 }, () =>
            line("10.0.0.2", "a.example", "RESOLVED")
        ).join("\n");
        expect(parseTail(many, true, all)).toHaveLength(TAIL_ROWS);
    });

    it("reads the engine's list metrics", () => {
        const metrics = parseEngineMetrics(
            [
                "# HELP blocky_denylist_cache_entries Number of entries",
                'blocky_denylist_cache_entries{group="ads"} 120000',
                'blocky_denylist_cache_entries{group="malware"} 5000',
                "blocky_last_list_group_refresh_timestamp_seconds 1.7604e+09",
                "blocky_failed_downloads_total 2"
            ].join("\n")
        );
        expect(metrics).toEqual({
            lists: [
                { name: "ads", count: 120000 },
                { name: "malware", count: 5000 }
            ],
            listed: 125000,
            lastRefresh: 1.7604e12,
            failedDownloads: 2
        });
        expect(parseEngineMetrics("").lastRefresh).toBeNull();
    });

    it("reads the engine's blocking status sentence", () => {
        expect(parseBlockingStatus("blocking enabled")).toEqual({
            enabled: true,
            secondsLeft: null
        });
        expect(parseBlockingStatus("blocking disabled for 120 seconds")).toEqual({
            enabled: false,
            secondsLeft: 120
        });
        expect(parseBlockingStatus("blocking disabled")).toEqual({
            enabled: false,
            secondsLeft: null
        });
    });

    it("bounds a pause and takes a domain from the log as a rule", () => {
        expect(pauseSchema.parse({ seconds: 0 }).seconds).toBe(0);
        expect(pauseSchema.safeParse({ seconds: 90_000 }).success).toBe(false);
        expect(ruleFromLogSchema.parse({ domain: "Ads.Example.com.", list: "allow" })).toEqual({
            domain: "ads.example.com",
            list: "allow"
        });
        expect(ruleFromLogSchema.safeParse({ domain: "/x/", list: "deny" }).success).toBe(false);
    });
});

describe("name lookup", () => {
    it("takes one plain name, normalized, and refuses patterns", () => {
        expect(lookupSchema.parse({ domain: " HTTPS://Ads.Example.com/x " }).domain).toBe(
            "ads.example.com"
        );
        for (const domain of ["", "*.example.com", "/ads/", "a b.com", "x;rm -rf /"])
            expect(lookupSchema.safeParse({ domain }).success).toBe(false);
    });

    it("reads a blocked answer with the list that blocked it", () => {
        const lookup = parseLookup(
            "ads.example.com",
            JSON.stringify({
                reason: "BLOCKED (ads)",
                response: "A (0.0.0.0)",
                responseType: "BLOCKED",
                returnCode: "NOERROR"
            })
        );
        expect(lookup).toMatchObject({ outcome: "blocked", list: "ads", via: "blocked" });
    });

    it("reads an answered name with the resolver, and refuses anything else", () => {
        const lookup = parseLookup(
            "example.com",
            JSON.stringify({
                reason: "RESOLVED (tcp-tls:1.1.1.1:853)",
                response: "A (93.184.215.14)",
                responseType: "RESOLVED",
                returnCode: "NOERROR"
            })
        );
        expect(lookup).toMatchObject({ outcome: "allowed", list: "", via: "tcp-tls:1.1.1.1:853" });
        expect(parseLookup("example.com", "Connection refused")).toBeNull();
        expect(parseLookup("example.com", "{\"reason\":1}")).toBeNull();
    });
});

describe("devices seen", () => {
    it("counts each device with its first and last lookup, busiest first", () => {
        const read = reader({ outcome: "blocked" });
        read.add(line("192.168.1.20", "a.com", "RESOLVED", { time: "2026-10-18 09:00:00" }));
        read.add(line("192.168.1.20", "ads.com", "BLOCKED", { time: "2026-10-18 11:00:00" }));
        read.add(line("192.168.1.20", "b.com", "CACHED", { time: "2026-10-18 10:00:00" }));
        read.add(line("192.168.1.30", "c.com", "RESOLVED", { name: "tv.lan" }));
        expect(read.devices()).toEqual([
            {
                address: "192.168.1.20",
                name: "",
                queries: 3,
                blocked: 1,
                first: Date.parse("2026-10-18T09:00:00Z"),
                last: Date.parse("2026-10-18T11:00:00Z")
            },
            {
                address: "192.168.1.30",
                name: "tv.lan",
                queries: 1,
                blocked: 0,
                first: Date.parse("2026-10-18T10:00:00Z"),
                last: Date.parse("2026-10-18T10:00:00Z")
            }
        ]);
    });
});
