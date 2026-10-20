/**
 * Blocked services: each one its own list in the engine, its names read from
 * AdGuard's public registry on save. Only the rules that mean exactly a name, or
 * a name and everything under it, survive the conversion - a rule with a
 * modifier read as a plain name would block far more than it says.
 */

import { ENV_VALUE_MAX } from "@polaris/core";
import * as dns from "@/lib/dns-blocker/settings";
import * as render from "@/lib/dns-blocker/render";
import { afterEach, describe, expect, it, vi } from "vitest";

const follow = vi.fn();
vi.mock("@/lib/safe-fetch", () => ({
    follow: (...args: unknown[]) => follow(...args),
    readCapped: async (response: { text: string }) => new TextEncoder().encode(response.text)
}));

const registry = await import("@/lib/dns-blocker/services-registry");

const REGISTRY = {
    blocked_services: [
        {
            id: "youtube",
            name: "YouTube",
            rules: ["||youtube.com^", "||YouTu.be^", "|exact.ytimg.com^", "||youtube.com^"]
        },
        {
            id: "netflix",
            name: "Netflix",
            rules: [
                "||netflix.com^",
                "||dualstack.apiproxy-*.amazonaws.com^",
                "||amazonaws.com^$dnstype=~CNAME",
                "/_spotify-connect._tcp.local/",
                "||slack-files.com ^"
            ]
        },
        { id: "tiktok", name: "TikTok", rules: ["||tiktok.com^"] }
    ]
};

function settings(patch: Partial<dns.DnsSettings> = {}): dns.DnsSettings {
    return {
        ...dns.DEFAULT_DNS_SETTINGS,
        serviceDomains: { youtube: ["*.youtube.com", "*.youtu.be"], tiktok: ["*.tiktok.com"] },
        ...patch
    };
}

type Blocking = {
    denylists: Record<string, string[]>;
    clientGroupsBlock: Record<string, string[]>;
    listSchedules?: Record<string, string[]>;
};
const blocking = (value: dns.DnsSettings) =>
    render.blockyConfig(value, new Date("2026-07-01T12:00:00Z")).blocking as Blocking;

afterEach(() => follow.mockReset());

describe("namesFromRules", () => {
    it("keeps names and wildcards, and drops modifiers, inner wildcards and regexes", () => {
        expect(registry.namesFromRules(REGISTRY.blocked_services[1]!.rules)).toEqual([
            "*.netflix.com"
        ]);
        expect(registry.namesFromRules(REGISTRY.blocked_services[0]!.rules)).toEqual([
            "*.youtube.com",
            "*.youtu.be",
            "exact.ytimg.com"
        ]);
    });

    it("reads only the wanted services, and nothing from an answer that is not the registry", () => {
        expect(registry.namesFromRegistry(REGISTRY, ["tiktok", "steam"])).toEqual({
            tiktok: ["*.tiktok.com"]
        });
        expect(registry.namesFromRegistry({ services: [] }, ["tiktok"])).toEqual({});
    });
});

describe("fetchServiceNames", () => {
    it("reads the registry through the guarded fetch", async () => {
        follow.mockResolvedValue({ ok: true, text: JSON.stringify(REGISTRY) });
        await expect(registry.fetchServiceNames(["tiktok"])).resolves.toEqual({
            tiktok: ["*.tiktok.com"]
        });
        expect(String(follow.mock.calls[0]?.[0])).toBe(registry.SERVICES_REGISTRY_URL);
    });

    it("is null offline or on an error answer, and asks nothing for no services", async () => {
        follow.mockResolvedValue(null);
        await expect(registry.fetchServiceNames(["tiktok"])).resolves.toBeNull();
        follow.mockResolvedValue({ ok: false, text: "" });
        await expect(registry.fetchServiceNames(["tiktok"])).resolves.toBeNull();
        follow.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        await expect(registry.fetchServiceNames(["tiktok"])).resolves.toBeNull();
        follow.mockReset();
        await expect(registry.fetchServiceNames([])).resolves.toEqual({});
        expect(follow).not.toHaveBeenCalled();
    });
});

describe("rendered services", () => {
    it("gives each service in use a list of its own, blocked by default when on", () => {
        const config = blocking(settings({ services: ["youtube"] }));
        expect(config.denylists["service-youtube"]).toEqual(["*.youtube.com\n*.youtu.be\n"]);
        expect(config.denylists["service-tiktok"]).toBeUndefined();
        expect(config.clientGroupsBlock.default).toEqual([
            "ads",
            "malware",
            "service-youtube",
            "polaris"
        ]);
    });

    it("lets a device group block a service nobody else does", () => {
        const config = blocking(
            settings({
                clientGroups: [
                    { name: "Kids", clients: ["kids-*"], categories: [], services: ["tiktok"] }
                ]
            })
        );
        expect(config.denylists["service-tiktok"]).toBeTruthy();
        expect(config.clientGroupsBlock.default).not.toContain("service-tiktok");
        expect(config.clientGroupsBlock["kids-*"]).toEqual(["service-tiktok", "polaris"]);
    });

    it("leaves out a service whose names were never downloaded", () => {
        const config = blocking(settings({ services: ["steam"] }));
        expect(Object.keys(config.denylists)).not.toContain("service-steam");
        expect(config.clientGroupsBlock.default).not.toContain("service-steam");
    });

    it("can be scheduled like a category", () => {
        const config = blocking(
            settings({
                services: ["youtube"],
                schedules: [{ lists: ["service-youtube"], days: ["mon"], start: "", end: "" }],
                timeZone: "UTC"
            })
        );
        expect(config.listSchedules).toEqual({ "service-youtube": ["polaris-1-1"] });
    });

    it("still fits the one environment value with every service on", () => {
        // About the registry's real size: every offered service is ~19 KB of names.
        const names = Array.from({ length: 20 }, (_, at) => `*.cdn${at}.service-example.com`);
        const all = dns.DNS_SERVICES.map((service) => service.id);
        const encoded = render.encodeBlockyConfig(
            settings({
                services: all,
                serviceDomains: Object.fromEntries(all.map((id) => [id, names])),
                safeSearch: true
            })
        );
        expect(encoded.length).toBeLessThan(ENV_VALUE_MAX);
    });
});

describe("service settings", () => {
    it("drops unknown services and names that are not names when read back", () => {
        const read = dns.readDnsSettings({
            services: ["youtube", "myspace"],
            serviceDomains: { youtube: ["*.youtube.com", "/re/", "not a name"], myspace: ["x.com"] }
        });
        expect(read.services).toEqual(["youtube"]);
        expect(read.serviceDomains).toEqual({ youtube: ["*.youtube.com"] });
    });

    it("reads a group saved before services existed", () => {
        const read = dns.readDnsSettings({
            clientGroups: [{ name: "Kids", clients: ["10.0.0.9"], categories: ["social"] }]
        });
        expect(read.clientGroups).toEqual([
            { name: "Kids", clients: ["10.0.0.9"], categories: ["social"], services: [] }
        ]);
    });

    it("offers the services in use, for everybody or a group, to schedules", () => {
        expect(
            dns.dnsSchedulableLists({
                sources: ["hagezi-social"],
                customLists: [],
                services: ["youtube"],
                clientGroups: [{ name: "K", clients: ["k"], categories: [], services: ["tiktok"] }]
            })
        ).toEqual(
            ["social", "tiktok", "youtube"].map((id) =>
                id === "social" ? id : dns.dnsServiceList(id)
            )
        );
    });

    it("offers each service once, by a registry-style id", () => {
        expect(new Set(dns.DNS_SERVICES.map((service) => service.id)).size).toBe(
            dns.DNS_SERVICES.length
        );
        expect(dns.DNS_SERVICES.every((service) => /^[a-z0-9_]+$/.test(service.id))).toBe(true);
    });
});

describe("resolveServiceNames", () => {
    const using = { services: ["youtube"], clientGroups: [] };
    const fresh = { youtube: ["*.youtube.com", "*.youtu.be"] };

    it("downloads the names again on every save", async () => {
        const fetchNames = vi.fn(async () => fresh);
        await expect(
            registry.resolveServiceNames(using, { youtube: ["old.example"] }, fetchNames)
        ).resolves.toEqual({ names: fresh });
        expect(fetchNames).toHaveBeenCalledWith(["youtube"]);
    });

    it("keeps the last names offline, and refuses a service it never had names for", async () => {
        const offline = vi.fn(async () => null);
        await expect(
            registry.resolveServiceNames(using, { youtube: ["*.youtube.com"] }, offline)
        ).resolves.toEqual({ names: { youtube: ["*.youtube.com"] } });
        await expect(registry.resolveServiceNames(using, {}, offline)).resolves.toEqual({
            refusal: "servicesOffline"
        });
    });

    it("refuses a service the registry no longer has", async () => {
        const fetchNames = vi.fn(async () => ({ tiktok: ["*.tiktok.com"] }));
        await expect(
            registry.resolveServiceNames(
                { services: ["youtube", "tiktok"], clientGroups: [] },
                {},
                fetchNames
            )
        ).resolves.toEqual({ refusal: "servicesMissing" });
    });

    it("asks nothing when no service is in use", async () => {
        const fetchNames = vi.fn(async () => fresh);
        await expect(
            registry.resolveServiceNames({ services: [], clientGroups: [] }, fresh, fetchNames)
        ).resolves.toEqual({ names: {} });
        expect(fetchNames).not.toHaveBeenCalled();
    });
});
