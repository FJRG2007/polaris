/**
 * Whether one run of a check counts as up, and which addresses a check may dial.
 */

import { describe, expect, it } from "vitest";
import {
    addressAllowed,
    clampTimeout,
    evaluate,
    nextRunAt,
    statusMatches,
    type CheckSpec
} from "@polaris-app/status-pages/src/model/checks";

const spec = (patch: Partial<CheckSpec> = {}): CheckSpec => ({
    kind: "http",
    target: "https://example.com/",
    port: null,
    expectStatus: null,
    keyword: "",
    dnsType: null,
    dnsExpect: "",
    timeoutMs: 10_000,
    ...patch
});

describe("statusMatches", () => {
    it("takes any 2xx or 3xx when no status is named", () => {
        expect(statusMatches(200, null)).toBe(true);
        expect(statusMatches(302, null)).toBe(true);
        expect(statusMatches(404, null)).toBe(false);
        expect(statusMatches(503, null)).toBe(false);
    });

    it("takes only the named status when there is one", () => {
        expect(statusMatches(401, 401)).toBe(true);
        expect(statusMatches(200, 401)).toBe(false);
    });
});

describe("evaluate", () => {
    it("is up on an expected status", () => {
        expect(evaluate(spec(), { kind: "http", status: 204, body: "", latencyMs: 40 })).toEqual({
            ok: true,
            latencyMs: 40,
            error: null
        });
    });

    it("is down on an unexpected status", () => {
        expect(evaluate(spec(), { kind: "http", status: 500, body: "", latencyMs: 40 }).error).toBe("status");
    });

    it("checks the keyword after the status", () => {
        const keyword = spec({ keyword: "healthy" });
        expect(evaluate(keyword, { kind: "http", status: 200, body: "all healthy", latencyMs: 1 }).ok).toBe(true);
        expect(evaluate(keyword, { kind: "http", status: 200, body: "degraded", latencyMs: 1 }).error).toBe("keyword");
    });

    it("passes a network failure through as down", () => {
        expect(evaluate(spec(), { kind: "error", error: "timeout", latencyMs: null })).toEqual({
            ok: false,
            latencyMs: null,
            error: "timeout"
        });
    });

    it("is up when a TCP connection opens", () => {
        expect(evaluate(spec({ kind: "tcp", port: 22 }), { kind: "tcp", latencyMs: 3 }).ok).toBe(true);
    });

    it("compares DNS answers without case or a trailing dot", () => {
        const dns = spec({ kind: "dns", dnsType: "CNAME", dnsExpect: "Edge.Example.com." });
        expect(evaluate(dns, { kind: "dns", answers: ["edge.example.com"], latencyMs: 2 }).ok).toBe(true);
        expect(evaluate(dns, { kind: "dns", answers: ["other.example.com"], latencyMs: 2 }).error).toBe("dnsMismatch");
        expect(evaluate(dns, { kind: "dns", answers: [], latencyMs: 2 }).error).toBe("dnsEmpty");
    });

    it("takes any DNS answer when no value is expected", () => {
        const dns = spec({ kind: "dns", dnsType: "A" });
        expect(evaluate(dns, { kind: "dns", answers: ["192.0.2.1"], latencyMs: 2 }).ok).toBe(true);
    });
});

describe("addressAllowed", () => {
    it("allows public and private network addresses", () => {
        for (const address of ["93.184.216.34", "192.168.1.10", "10.0.0.5", "172.16.3.4", "2001:db8::1"]) {
            expect(addressAllowed(address)).toBe(true);
        }
    });

    it("refuses loopback, link-local, unspecified and multicast", () => {
        for (const address of [
            "127.0.0.1",
            "169.254.169.254",
            "0.0.0.0",
            "224.0.0.1",
            "::1",
            "::",
            "fe80::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254"
        ]) {
            expect(addressAllowed(address)).toBe(false);
        }
    });

    it("refuses what is not an address", () => {
        expect(addressAllowed("999.1.1.1")).toBe(false);
        expect(addressAllowed("example.com")).toBe(false);
    });
});

describe("bounds", () => {
    it("never schedules a check sooner than thirty seconds", () => {
        const from = new Date("2026-01-01T00:00:00Z");
        expect(nextRunAt(from, 5).getTime() - from.getTime()).toBe(30_000);
        expect(nextRunAt(from, 120).getTime() - from.getTime()).toBe(120_000);
    });

    it("holds a timeout between one and fifteen seconds", () => {
        expect(clampTimeout(10)).toBe(1000);
        expect(clampTimeout(60_000)).toBe(15_000);
        expect(clampTimeout(5000)).toBe(5000);
    });
});
