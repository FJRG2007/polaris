/** The AAAA pass against a Cloudflare zone held in memory. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const HOME = "2001:db8:0:1::10";
const settings = new Map<string, string>();
let token: string | null = "cf-token";
const zone = new Map<string, { id: string; type: string; content: string; proxied: boolean }[]>();
let nextId = 0;

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string) => void settings.set(key, value)
}));
vi.mock("@/lib/domain-zones", () => ({
    getDomainZones: async () => ({ baseDomain: "example.com" }),
    zoneRecords: () => [{ host: "polaris.example.com", wildcard: "*.polaris.example.com" }]
}));
vi.mock("@/lib/integrations/cloudflare-account-service", () => ({
    loadCloudflareToken: async () => token
}));
vi.mock("@/lib/integrations/cloudflare-api", () => ({
    resolveZoneForHostname: async () => ({ id: "zone-1" }),
    findAddressRecords: async (_t: string, _z: string, name: string) =>
        (zone.get(name) ?? []).map((entry) => ({ ...entry })),
    createAddressRecord: async (
        _t: string,
        _z: string,
        input: { type: string; name: string; content: string; proxied: boolean }
    ) => {
        const id = `r${(nextId += 1)}`;
        zone.set(input.name, [...(zone.get(input.name) ?? []), { id, ...input }]);
        return id;
    },
    repointRecord: async (_t: string, _z: string, id: string, content: string) => {
        for (const list of zone.values())
            for (const entry of list) if (entry.id === id) entry.content = content;
    },
    deleteDnsRecord: async (_t: string, _z: string, id: string) => {
        for (const [name, list] of zone)
            zone.set(
                name,
                list.filter((entry) => entry.id !== id)
            );
    }
}));

const { syncAaaa } = await import("@/lib/backup-access/aaaa-service");
const aaaa = (name: string) => (zone.get(name) ?? []).filter((entry) => entry.type === "AAAA");

beforeEach(() => {
    settings.clear();
    zone.clear();
    token = "cf-token";
    zone.set("polaris.example.com", [{ id: "a1", type: "A", content: "52.0.0.1", proxied: false }]);
});

describe("syncAaaa", () => {
    it("publishes on every web name once reachable, and again writes nothing", async () => {
        await syncAaaa({ ipv6: HOME, inbound: true });
        expect(aaaa("polaris.example.com").map((entry) => entry.content)).toEqual([HOME]);
        expect(aaaa("*.polaris.example.com").map((entry) => entry.content)).toEqual([HOME]);
        const before = JSON.stringify([...zone]);
        await syncAaaa({ ipv6: HOME, inbound: true });
        expect(JSON.stringify([...zone])).toBe(before);
    });

    it("removes them after repeated failed checks", async () => {
        await syncAaaa({ ipv6: HOME, inbound: true });
        await syncAaaa({ ipv6: HOME, inbound: false });
        await syncAaaa({ ipv6: HOME, inbound: false });
        expect(aaaa("polaris.example.com")).toHaveLength(1);
        await syncAaaa({ ipv6: HOME, inbound: false });
        expect(aaaa("polaris.example.com")).toHaveLength(0);
        expect(aaaa("*.polaris.example.com")).toHaveLength(0);
    });

    it("says when there is no Cloudflare account to write with", async () => {
        token = null;
        const state = await syncAaaa({ ipv6: HOME, inbound: true });
        expect(state.published).toBeNull();
        expect(state.problem).toBe("no-cloudflare");
        expect(aaaa("polaris.example.com")).toHaveLength(0);
    });
});
