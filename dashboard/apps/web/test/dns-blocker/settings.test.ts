/**
 * The blocker's settings: what a rule, a resolver and a stored row may be.
 *
 * The engine reads Go RE2 regular expressions and a fixed resolver syntax; a
 * rule it cannot read stops it starting, so those are refused when typed. A row
 * stored by an older screen is read field by field rather than thrown away.
 */

import { describe, expect, it } from "vitest";
import * as dns from "@/lib/dns-blocker/settings";

describe("normalizeDnsRule", () => {
    it.each([
        ["  Ads.Example.COM. ", "ads.example.com"],
        ["https://tracker.example.com/path", "tracker.example.com"],
        ["*.Example.com", "*.example.com"],
        ["/^ads?[0-9]*\\./", "/^ads?[0-9]*\\./"]
    ])("keeps %j as %j", (input, expected) => {
        expect(dns.normalizeDnsRule(input)).toBe(expected);
    });

    it.each([
        "",
        "not a name",
        "-bad.example.com",
        "*.",
        "/(?<=x)ads/",
        "/(?=x)/",
        "/(a)\\1/",
        "/[unclosed/",
        "/a\nexample.com/",
        "ads.example.com\r\ntracker.example.com"
    ])("refuses %j", (input) => {
        expect(dns.normalizeDnsRule(input)).toBeNull();
    });
});

describe("normalizeUpstream", () => {
    it.each([
        "https://dns.example.test/dns-query",
        "tcp-tls:dns.example.test:853",
        "tcp-tls:1.1.1.1",
        "192.168.1.1",
        "192.168.1.1:5353"
    ])("accepts %j", (input) => {
        expect(dns.normalizeUpstream(` ${input} `)).toBe(input);
    });

    it.each([
        "",
        "http://dns.example.test",
        "dns.example.test",
        "192.168.1.1:0",
        "192.168.1.1:70000",
        "tcp-tls:bad host"
    ])("refuses %j", (input) => {
        expect(dns.normalizeUpstream(input)).toBeNull();
    });
});

describe("dnsSettingsSchema", () => {
    const base = dns.DEFAULT_DNS_SETTINGS;

    it("normalizes what the save path receives", () => {
        const parsed = dns.dnsSettingsSchema.parse({
            ...base,
            allow: [" OK.Example.test "],
            records: [{ name: "NAS.home.", address: " 192.168.1.10 " }]
        });
        expect(parsed.allow).toEqual(["ok.example.test"]);
        expect(parsed.records).toEqual([{ name: "nas.home", address: "192.168.1.10" }]);
    });

    it.each([
        ["a rule the engine cannot read", { deny: ["/(?!x)/"] }],
        ["a record with a bad address", { records: [{ name: "nas.home", address: "999.1.1.1" }] }],
        [
            "a list that is not a web address",
            { customLists: [{ url: "ftp://lists.example.test/l", category: "ads" }] }
        ],
        [
            "a list in no category",
            { customLists: [{ url: "https://lists.example.test/l", category: "news" }] }
        ],
        ["a refresh under an hour", { refreshHours: 0 }],
        ["a refresh over a week", { refreshHours: 169 }]
    ])("refuses %s", (_label, patch) => {
        expect(dns.dnsSettingsSchema.safeParse({ ...base, ...patch }).success).toBe(false);
    });
});

describe("readDnsSettings", () => {
    it("reads nothing stored as the defaults", () => {
        expect(dns.readDnsSettings(undefined)).toEqual(dns.DEFAULT_DNS_SETTINGS);
        expect(dns.readDnsSettings("garbage")).toEqual(dns.DEFAULT_DNS_SETTINGS);
    });

    it("keeps the good fields when one is bad, and drops unknown list ids", () => {
        const read = dns.readDnsSettings({
            sources: ["hagezi-pro", "gone-list"],
            allow: ["ok.example.test"],
            deny: ["/(?<=x)/"],
            refreshHours: "often"
        });
        expect(read.sources).toEqual(["hagezi-pro"]);
        expect(read.allow).toEqual(["ok.example.test"]);
        expect(read.deny).toEqual([]);
        expect(read.refreshHours).toBe(dns.DEFAULT_DNS_SETTINGS.refreshHours);
    });

    it("falls back to the default resolver for an unknown preset or an empty custom one", () => {
        expect(dns.readDnsSettings({ upstream: "retired" }).upstream).toBe("cloudflare");
        expect(dns.readDnsSettings({ upstream: "custom", customUpstreams: [] }).upstream).toBe(
            "cloudflare"
        );
        expect(
            dns.readDnsSettings({ upstream: "custom", customUpstreams: ["192.168.1.1"] }).upstream
        ).toBe("custom");
    });
});
