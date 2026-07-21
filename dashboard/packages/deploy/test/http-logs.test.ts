import { describe, expect, it } from "vitest";
import { bucketHttpMetrics, parseHttpLogs, type HttpLogEntry } from "../src/http-logs.js";

function entry(over: Partial<HttpLogEntry>): HttpLogEntry {
    return {
        time: null,
        ip: "1.2.3.4",
        method: "GET",
        path: "/",
        status: 200,
        host: null,
        bytes: null,
        referer: null,
        userAgent: null,
        durationMs: null,
        ...over
    };
}

describe("parseHttpLogs", () => {
    it("parses nginx/Apache Combined Log Format", () => {
        const raw =
            '192.168.1.131 - - [21/Jul/2026:12:32:05 +0000] "GET /health HTTP/1.1" 304 0 "-" "Mozilla/5.0 Chrome/145" "-"';
        const [entry] = parseHttpLogs(raw);
        expect(entry).toMatchObject({
            ip: "192.168.1.131",
            method: "GET",
            path: "/health",
            status: 304,
            bytes: 0,
            referer: null,
            userAgent: "Mozilla/5.0 Chrome/145"
        });
        expect(entry!.time).toBe("2026-07-21T12:32:05.000Z");
    });

    it("strips a leading Docker --timestamps token and reuses it when the line has none", () => {
        const raw = '2026-07-21T12:32:05.123456789Z 10.0.0.5 - - [-] "POST /api HTTP/2.0" 500 12 "-" "curl/8"';
        const [entry] = parseHttpLogs(raw);
        expect(entry).toMatchObject({ ip: "10.0.0.5", method: "POST", path: "/api", status: 500 });
    });

    it("parses Traefik-style JSON access logs and normalizes fields", () => {
        const raw = JSON.stringify({
            ClientHost: "203.0.113.9",
            RequestMethod: "GET",
            RequestPath: "/",
            RequestHost: "app.example.com",
            DownstreamStatus: 200,
            Duration: 2_500_000,
            "request_User-Agent": "Safari/537",
            StartUTC: "2026-07-21T12:40:00Z"
        });
        const [entry] = parseHttpLogs(raw);
        expect(entry).toMatchObject({
            ip: "203.0.113.9",
            method: "GET",
            path: "/",
            host: "app.example.com",
            status: 200,
            userAgent: "Safari/537",
            durationMs: 2.5,
            time: "2026-07-21T12:40:00.000Z"
        });
    });

    it("drops non-access lines (startup notices, malformed JSON) and keeps only requests", () => {
        const raw = [
            "2026/07/21 12:31:32 [notice] 1#1: start worker process 27",
            '192.168.1.131 - - [21/Jul/2026:12:32:05 +0000] "GET / HTTP/1.1" 200 5 "-" "UA"',
            "{ not valid json",
            '{"msg":"router created","level":"info"}'
        ].join("\n");
        const entries = parseHttpLogs(raw);
        expect(entries).toHaveLength(1);
        expect(entries[0]!.path).toBe("/");
    });

    it("returns nothing for an app that does not log HTTP access", () => {
        expect(parseHttpLogs("")).toEqual([]);
        expect(parseHttpLogs("Listening on :3000\nDB connected")).toEqual([]);
    });

    it("drops the client port from an ip:port address", () => {
        const raw = JSON.stringify({ ClientAddr: "198.51.100.2:52344", method: "GET", uri: "/x", status: 404 });
        expect(parseHttpLogs(raw)[0]!.ip).toBe("198.51.100.2");
    });
});

describe("bucketHttpMetrics", () => {
    const from = Date.UTC(2026, 0, 1, 0, 0, 0);
    const to = from + 60_000; // one minute

    it("buckets requests, 5xx error rate, mean response time, and throughput", () => {
        const at = (offsetMs: number) => new Date(from + offsetMs).toISOString();
        const entries = [
            entry({ time: at(1_000), status: 200, durationMs: 10, bytes: 1000 }),
            entry({ time: at(2_000), status: 500, durationMs: 30, bytes: 1000 }),
            entry({ time: at(3_000), status: 404, durationMs: null, bytes: 2000 })
        ];
        const [point] = bucketHttpMetrics(entries, from, to, 1);
        expect(point!.requests).toBe(3);
        expect(point!.errorRate).toBeCloseTo(100 / 3); // one 5xx of three
        expect(point!.avgResponseMs).toBe(20); // (10 + 30) / 2, 404 has no duration
        expect(point!.bytesPerSec).toBeCloseTo(4000 / 60); // 4000 bytes over 60s
    });

    it("marks empty buckets with a null error rate and spreads points across the window", () => {
        const points = bucketHttpMetrics([entry({ time: new Date(from + 1_000).toISOString() })], from, to, 4);
        expect(points).toHaveLength(4);
        expect(points[0]!.requests).toBe(1);
        expect(points[0]!.errorRate).toBe(0);
        expect(points[3]!.requests).toBe(0);
        expect(points[3]!.errorRate).toBeNull();
    });

    it("ignores entries outside the window or without a time, and rejects a bad range", () => {
        const entries = [entry({ time: new Date(to + 5_000).toISOString() }), entry({ time: null })];
        expect(bucketHttpMetrics(entries, from, to, 1)[0]!.requests).toBe(0);
        expect(bucketHttpMetrics(entries, to, from, 1)).toEqual([]);
    });
});
