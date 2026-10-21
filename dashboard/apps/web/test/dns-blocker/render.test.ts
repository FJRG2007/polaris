/**
 * The engine's configuration, rendered from the operator's settings.
 *
 * A configuration the engine refuses is a resolver that does not start, and
 * every device on the network loses names at once, so every shape the renderer
 * can produce is pinned here.
 */

import { describe, expect, it } from "vitest";
import { ENV_VALUE_MAX } from "@polaris/core";
import * as dns from "@/lib/dns-blocker/settings";
import * as render from "@/lib/dns-blocker/render";

type Blocking = {
    denylists: Record<string, string[]>;
    allowlists?: Record<string, string[]>;
    clientGroupsBlock: { default: string[] };
};

function settings(patch: Partial<dns.DnsSettings> = {}): dns.DnsSettings {
    return { ...dns.DEFAULT_DNS_SETTINGS, ...patch };
}

function blocking(config: Record<string, unknown>): Blocking {
    return config.blocking as Blocking;
}

function servers(config: Record<string, unknown>): string[] {
    return (config.upstreams as { groups: { default: string[] } }).groups.default;
}

describe("blockyConfig", () => {
    it("always blocks the check name in the polaris group, even with nothing else on", () => {
        const config = render.blockyConfig(settings({ sources: [] }));
        expect(blocking(config).denylists).toEqual({
            polaris: [`${dns.DNS_CHECK_NAME}\n`, render.RULES_DENY_PATH]
        });
        expect(blocking(config).clientGroupsBlock.default).toEqual(["polaris"]);
    });

    it("puts each enabled list and custom list under its category, in category order", () => {
        const config = render.blockyConfig(
            settings({
                sources: ["hagezi-tif", "hagezi-pro"],
                customLists: [{ url: "https://lists.example.test/social.txt", category: "social" }],
                deny: ["ads.example.test"]
            })
        );
        const { denylists, clientGroupsBlock } = blocking(config);
        const url = (id: string) => dns.DNS_LIST_SOURCES.find((source) => source.id === id)?.url;
        expect(denylists.ads).toEqual([url("hagezi-pro")]);
        expect(denylists.malware).toEqual([url("hagezi-tif")]);
        expect(denylists.social).toEqual(["https://lists.example.test/social.txt"]);
        // The rules are a file the engine loads, never part of the configuration.
        expect(denylists.polaris).toEqual([`${dns.DNS_CHECK_NAME}\n`, render.RULES_DENY_PATH]);
        expect(clientGroupsBlock.default).toEqual(["ads", "malware", "social", "polaris"]);
    });

    it("names the allow file once, in the polaris group, whether or not it holds a rule", () => {
        const none = render.blockyConfig(settings());
        const some = render.blockyConfig(
            settings({ allow: ["ok.example.test", "*.cdn.example.test"], deny: ["ads.example.test"] })
        );
        expect(blocking(none).allowlists).toEqual({ polaris: [render.RULES_ALLOW_PATH] });
        // A rule added or removed leaves the configuration - and so the running
        // server - exactly as it was.
        expect(some).toEqual(none);
        expect(blocking(some).clientGroupsBlock.default).toContain("polaris");
    });

    it("writes the rules as the two files the configuration names", () => {
        const files = render.ruleFiles({ allow: ["ok.example.test"], deny: ["*.ads.test", "/^ad/"] });
        expect(files.get(render.RULES_ALLOW_PATH)).toBe("# Polaris: your rules\nok.example.test\n");
        expect(files.get(render.RULES_DENY_PATH)).toBe("# Polaris: your rules\n*.ads.test\n/^ad/\n");
        expect(render.ruleFiles({ allow: [], deny: [] }).get(render.RULES_DENY_PATH)).toBe(
            "# Polaris: your rules\n"
        );
    });

    it("uses the preset's resolvers, and a fallback bootstrap only for encrypted custom ones", () => {
        const preset = dns.DNS_UPSTREAM_PRESETS.find((item) => item.id === "cloudflare");
        expect(servers(render.blockyConfig(settings()))).toEqual(preset?.servers);

        const plain = render.blockyConfig(
            settings({ upstream: "custom", customUpstreams: ["192.168.1.1"] })
        );
        expect(servers(plain)).toEqual(["192.168.1.1"]);
        expect(plain.bootstrapDns).toBeUndefined();

        const encrypted = render.blockyConfig(
            settings({ upstream: "custom", customUpstreams: ["tcp-tls:dns.example.test:853"] })
        );
        expect(encrypted.bootstrapDns).toEqual(["tcp+udp:1.1.1.1", "tcp+udp:9.9.9.9"]);
    });

    it("maps local names, joining the addresses of one name without repeats", () => {
        const config = render.blockyConfig(
            settings({
                records: [
                    { name: "nas.home", address: "192.168.1.10" },
                    { name: "nas.home", address: "192.168.1.10" },
                    { name: "nas.home", address: "fd00::10" },
                    { name: "tv.home", address: "192.168.1.20" }
                ]
            })
        );
        expect((config.customDNS as { mapping: Record<string, string> }).mapping).toEqual({
            "nas.home": "192.168.1.10,fd00::10",
            "tv.home": "192.168.1.20"
        });
        expect(render.blockyConfig(settings()).customDNS).toBeUndefined();
    });

    it("writes JSON the engine can read whatever a rule holds, encoded as one value", () => {
        const odd = settings({ deny: ['/^ads?[0-9]*\\."quoted"/'] });
        const text = render.renderBlockyConfig(odd);
        expect(text.endsWith("\n")).toBe(true);
        expect(JSON.parse(text)).toEqual(render.blockyConfig(odd));
        const encoded = render.encodeBlockyConfig(odd);
        expect(encoded).not.toMatch(/[\r\n]/);
        expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(text);
    });

    it("fits the most allow rules the screen takes into one value, with every list on", () => {
        const allow = Array.from(
            { length: dns.DNS_LIMITS.rules },
            (_, index) => `allowed-${index}.cdn.example.test`
        );
        const encoded = render.encodeBlockyConfig(
            settings({ sources: dns.DNS_LIST_SOURCES.map((source) => source.id), allow })
        );
        expect(encoded.length).toBeLessThanOrEqual(ENV_VALUE_MAX);
    });
});

describe("Pi-hole parity settings", () => {
    it("gives each device group its own categories, always with the check name", () => {
        const config = render.blockyConfig(
            settings({
                sources: ["hagezi-pro", "hagezi-tif"],
                clientGroups: [
                    {
                        name: "Kids",
                        clients: ["192.168.1.0/24", "kids-*"],
                        categories: ["ads", "adult"]
                    }
                ]
            })
        );
        const groups = (config.blocking as { clientGroupsBlock: Record<string, string[]> })
            .clientGroupsBlock;
        expect(groups.default).toEqual(["ads", "malware", "polaris"]);
        // Adult has no list switched on, so it is left out rather than named empty.
        expect(groups["192.168.1.0/24"]).toEqual(["ads", "polaris"]);
        expect(groups["kids-*"]).toEqual(["ads", "polaris"]);
    });

    it("writes aliases as an absolute zone and leaves a clashing local name out", () => {
        const config = render.blockyConfig(
            settings({
                records: [
                    { name: "nas.home", address: "192.168.1.20" },
                    { name: "media.home", address: "192.168.1.21" }
                ],
                aliases: [{ name: "media.home", target: "nas.home" }]
            })
        );
        const custom = config.customDNS as { mapping: Record<string, string>; zone: string };
        expect(custom.mapping).toEqual({ "nas.home": "192.168.1.20" });
        expect(custom.zone).toBe("media.home. 300 IN CNAME nas.home.\n");
    });

    it("keeps the asked days of log, turns metrics on and names devices from the router", () => {
        const config = render.blockyConfig(settings({ logDays: 14, namesFrom: "192.168.1.1" }));
        expect(config.queryLog).toMatchObject({
            type: "csv",
            target: "/logs",
            logRetentionDays: 15
        });
        expect(config.prometheus).toEqual({ enable: true, path: "/metrics" });
        expect(config.clientLookup).toEqual({ upstream: "192.168.1.1", singleNameOrder: [1] });
        expect(render.blockyConfig(settings()).clientLookup).toBeUndefined();
    });

    it("reads an older stored row with the new fields defaulted", () => {
        const read = dns.readDnsSettings({ sources: ["hagezi-pro"], refreshHours: 12 });
        expect(read).toMatchObject({ aliases: [], clientGroups: [], logDays: 7, namesFrom: "" });
    });

    it("accepts addresses, ranges and device names as group clients", () => {
        expect(dns.normalizeDnsClient(" 192.168.1.20 ")).toBe("192.168.1.20");
        expect(dns.normalizeDnsClient("10.0.0.0/8")).toBe("10.0.0.0/8");
        expect(dns.normalizeDnsClient("Kids-*")).toBe("kids-*");
        expect(dns.normalizeDnsClient("10.0.0.0/40")).toBeNull();
        expect(dns.normalizeDnsClient("default")).toBeNull();
        expect(dns.normalizeDnsClient("a b")).toBeNull();
    });
});

describe("device names", () => {
    it("names devices by hand, merged by name, beside the router's names", () => {
        const devices = [
            { name: "ana-laptop", address: "192.168.1.20" },
            { name: "ana-laptop", address: "fd00::20" },
            { name: "tv", address: "192.168.1.30" }
        ];
        expect(render.blockyConfig(settings({ devices })).clientLookup).toEqual({
            clients: { "ana-laptop": ["192.168.1.20", "fd00::20"], tv: ["192.168.1.30"] }
        });
        expect(
            render.blockyConfig(settings({ devices, namesFrom: "192.168.1.1" })).clientLookup
        ).toMatchObject({ upstream: "192.168.1.1", singleNameOrder: [1] });
    });

    it("normalizes a typed name and refuses one with spaces", () => {
        expect(
            dns.dnsDeviceSchema.parse({ name: " Ana-Laptop ", address: " 192.168.1.20 " })
        ).toEqual({ name: "ana-laptop", address: "192.168.1.20" });
        expect(
            dns.dnsDeviceSchema.safeParse({ name: "ana laptop", address: "192.168.1.20" }).success
        ).toBe(false);
        expect(dns.dnsDeviceSchema.safeParse({ name: "tv", address: "not-an-ip" }).success).toBe(
            false
        );
        expect(dns.readDnsSettings({}).devices).toEqual([]);
    });
});

describe("local domains", () => {
    it("sends each domain to its servers, merged by domain", () => {
        const forwards = [
            { domain: "home.lan", server: "192.168.1.1" },
            { domain: "home.lan", server: "192.168.1.2:5353" },
            { domain: "168.192.in-addr.arpa", server: "192.168.1.1" }
        ];
        expect(render.blockyConfig(settings({ forwards })).conditional).toEqual({
            mapping: {
                "home.lan": "192.168.1.1,192.168.1.2:5353",
                "168.192.in-addr.arpa": "192.168.1.1"
            }
        });
        expect(render.blockyConfig(settings()).conditional).toBeUndefined();
    });

    it("normalizes the domain and refuses a server that is not one", () => {
        expect(
            dns.dnsForwardSchema.parse({ domain: "Home.LAN.", server: " 192.168.1.1 " })
        ).toEqual({ domain: "home.lan", server: "192.168.1.1" });
        expect(
            dns.dnsForwardSchema.safeParse({ domain: "home.lan", server: "router" }).success
        ).toBe(false);
        expect(
            dns.readDnsSettings({ forwards: [{ domain: "x y", server: "1.1.1.1" }] }).forwards
        ).toEqual([]);
    });
});

describe("safe search", () => {
    const zoneOf = (patch: Partial<dns.DnsSettings>) =>
        (render.blockyConfig(settings(patch)).customDNS as { zone?: string } | undefined)?.zone ??
        "";

    it("answers every Google domain and Bing with their locked hosts", () => {
        const zone = zoneOf({ safeSearch: true });
        expect(zone).toContain("www.google.com. 300 IN CNAME forcesafesearch.google.com.\n");
        expect(zone).toContain("www.google.es. 300 IN CNAME forcesafesearch.google.com.\n");
        expect(zone).toContain("www.bing.com. 300 IN CNAME strict.bing.com.\n");
        expect(zone).not.toContain("youtube");
    });

    it("restricts only the YouTube hosts Google names", () => {
        const zone = zoneOf({ youtube: "moderate" });
        expect(zone.trim().split("\n")).toEqual([
            "www.youtube.com. 300 IN CNAME restrictmoderate.youtube.com.",
            "m.youtube.com. 300 IN CNAME restrictmoderate.youtube.com.",
            "youtubei.googleapis.com. 300 IN CNAME restrictmoderate.youtube.com.",
            "youtube.googleapis.com. 300 IN CNAME restrictmoderate.youtube.com.",
            "www.youtube-nocookie.com. 300 IN CNAME restrictmoderate.youtube.com."
        ]);
        expect(zoneOf({ youtube: "strict" })).toContain("IN CNAME restrict.youtube.com.");
    });

    it("leaves a name the operator answers themselves alone", () => {
        const zone = zoneOf({
            safeSearch: true,
            records: [{ name: "www.google.com", address: "10.0.0.5" }],
            aliases: [{ name: "www.bing.com", target: "nas.home" }]
        });
        expect(zone).not.toContain("www.google.com. 300 IN CNAME forcesafesearch");
        expect(zone).toContain("www.bing.com. 300 IN CNAME nas.home.\n");
        expect(zone).not.toContain("www.bing.com. 300 IN CNAME strict.bing.com.");
    });

    it("is off for a fresh install and for an older stored row", () => {
        expect(render.blockyConfig(settings()).customDNS).toBeUndefined();
        expect(dns.readDnsSettings({ youtube: "nonsense" })).toMatchObject({
            safeSearch: false,
            youtube: "off"
        });
    });

    it("still fits the one environment value with everything on", () => {
        const encoded = render.encodeBlockyConfig(
            settings({ safeSearch: true, youtube: "strict" })
        );
        expect(encoded.length).toBeLessThan(ENV_VALUE_MAX);
    });
});

describe("engine settings", () => {
    it("renders what an install never set exactly as before", () => {
        const config = render.blockyConfig(settings({}));
        expect(config.caching).toEqual({ prefetching: true });
        expect(config).not.toHaveProperty("filtering");
        expect(config).not.toHaveProperty("fqdnOnly");
        expect(config).not.toHaveProperty("dnssec");
        expect((config.blocking as { blockType: string }).blockType).toBe("zeroIp");
    });

    it("writes the cache, the dropped types, the block reply and bare names", () => {
        const config = render.blockyConfig(
            settings({
                engine: {
                    cacheMinMinutes: 5,
                    cacheMaxMinutes: 60,
                    prefetch: false,
                    dropTypes: ["AAAA"],
                    blockReply: "nxDomain",
                    fqdnOnly: true,
                    dnssec: true
                }
            })
        );
        expect(config.caching).toEqual({ prefetching: false, minTime: "5m", maxTime: "60m" });
        expect(config.filtering).toEqual({ queryTypes: ["AAAA"] });
        expect(config.fqdnOnly).toEqual({ enable: true });
        expect(config.dnssec).toEqual({ validate: true });
        expect((config.blocking as { blockType: string }).blockType).toBe("nxDomain");
    });

    it("keeps the defaults for a row stored before, and refuses a min above the max", async () => {
        const dns = await import("@/lib/dns-blocker/settings");
        expect(dns.readDnsSettings({}).engine).toEqual(dns.DEFAULT_DNS_ENGINE);
        const { dnssec: _unset, ...beforeDnssec } = { ...dns.DEFAULT_DNS_ENGINE, prefetch: false };
        expect(dns.readDnsSettings({ engine: beforeDnssec }).engine).toEqual({
            ...dns.DEFAULT_DNS_ENGINE,
            prefetch: false
        });
        expect(
            dns.dnsEngineSchema.safeParse({
                ...dns.DEFAULT_DNS_ENGINE,
                cacheMinMinutes: 30,
                cacheMaxMinutes: 10
            }).success
        ).toBe(false);
    });
});
