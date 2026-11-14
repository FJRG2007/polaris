/**
 * Which records the DNS records screen marks as Polaris's, and the zone picker's
 * paging.
 *
 * - **Ownership comes from Polaris's own rows.** A game server's record by its
 *   stored id, a tunnel CNAME by the id its service kept, a deployed service's
 *   domain by name, the zone layout's hosts and wildcards, a game's wildcard, and
 *   an owner domain's proof only when the TXT value is its token.
 * - **Everything else stays unmarked**: MX, NS, SPF, a stranger's A record.
 * - **The filter** lists the managed records, or the rest.
 * - **Zones are read a page at a time** and searched by Cloudflare.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    gameDnsRecord: { findMany: vi.fn() },
    domain: { findMany: vi.fn() },
    setting: { findMany: vi.fn() },
    ownerDomain: { findMany: vi.fn() },
    installedApp: { findMany: vi.fn() },
    application: { findMany: vi.fn() }
}));
vi.mock("@polaris/db", () => ({ prisma: db }));
vi.mock("@/lib/apps/game-zones", () => ({
    installedGames: vi.fn(async () => [{ name: "Minecraft", domainLabel: "mc" }])
}));
vi.mock("@/lib/integrations/cloudflare-account-service", () => ({ loadCloudflareToken: vi.fn(async () => "tok") }));
vi.mock("@/lib/domain-zones", async (original) => ({
    ...(await original<typeof import("@/lib/domain-zones")>()),
    getDomainZones: vi.fn(async () => ({
        baseDomain: "example.test",
        zones: [
            { label: "polaris", scope: "polaris", primary: true },
            { label: "plr", scope: "deploy", primary: true }
        ]
    }))
}));

const owners = await import("@/lib/dns/record-owners");
const view = await import("@/lib/dns/records-view");

const ZONE = "0123456789abcdef0123456789abcdef";
const APP = "0190aaaa-0000-7000-8000-000000000001";
const SERVER = "0190bbbb-0000-7000-8000-000000000002";
const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

const records = [
    { id: "srv1", type: "SRV", name: "_minecraft._tcp.survival.mc.example.test", content: "0 5 25565 survival.mc.example.test" },
    { id: "cn1", type: "CNAME", name: "tunnel.example.test", content: "abc.cfargotunnel.com" },
    { id: "d1", type: "A", name: "shop.example.test", content: "203.0.113.5" },
    { id: "p1", type: "A", name: "polaris.example.test", content: "203.0.113.5" },
    { id: "p2", type: "A", name: "*.plr.example.test", content: "203.0.113.5" },
    { id: "g1", type: "A", name: "*.mc.example.test", content: "203.0.113.5" },
    { id: "v1", type: "TXT", name: "_polaris.brought.test", content: `"${TOKEN}"` },
    { id: "v2", type: "TXT", name: "_polaris.other.test", content: "not-the-token" },
    { id: "mx", type: "MX", name: "example.test", content: "mail.example.test" },
    { id: "ns", type: "NS", name: "example.test", content: "ns1.example.net" },
    { id: "spf", type: "TXT", name: "example.test", content: "v=spf1 -all" },
    { id: "x", type: "A", name: "vercel.example.test", content: "76.76.21.21" },
    // A TXT at a name Polaris points at itself is not Polaris's.
    { id: "t1", type: "TXT", name: "polaris.example.test", content: "deadbeef" }
];

beforeEach(() => {
    db.gameDnsRecord.findMany.mockResolvedValue([{ recordId: "srv1", installedAppId: SERVER, type: "SRV" }]);
    db.installedApp.findMany.mockResolvedValue([{ id: SERVER, name: "Survival" }]);
    db.domain.findMany.mockResolvedValue([
        { hostname: "shop.example.test", application: { id: APP, name: "Shop", environment: { projectId: "proj" } } }
    ]);
    db.setting.findMany.mockResolvedValue([
        { key: `deploy.ntunnel.${APP}.managed`, value: JSON.stringify({ tunnelId: "t", zoneId: ZONE, dnsId: "cn1" }) },
        // Another zone's tunnel claims nothing here.
        { key: `deploy.ntunnel.${SERVER}.managed`, value: JSON.stringify({ tunnelId: "t", zoneId: "f".repeat(32), dnsId: "x" }) },
        { key: `deploy.ntunnel.${APP}.managed.bad`, value: "{" }
    ]);
    db.application.findMany.mockResolvedValue([{ id: APP, name: "Shop", environment: { projectId: "proj" } }]);
    db.ownerDomain.findMany.mockResolvedValue([
        { domain: "brought.test", verifyToken: TOKEN, verifiedAt: new Date() },
        { domain: "other.test", verifyToken: "something-else", verifiedAt: null }
    ]);
});

afterEach(() => vi.clearAllMocks());

async function annotated() {
    const facts = await owners.loadOwnershipFacts(ZONE, records);
    return new Map(owners.withOwners(records, facts).map((record) => [record.id, record.owner ?? null]));
}

describe("which records Polaris manages", () => {
    it("names each kind from Polaris's own data, with where it lives", async () => {
        const owned = await annotated();
        expect(owned.get("srv1")).toEqual({ kind: "game-server", label: "Survival", href: `/apps/installed/${SERVER}` });
        expect(owned.get("cn1")).toEqual({ kind: "tunnel", label: "Shop", href: `/apps/deploy/proj?service=${APP}` });
        expect(owned.get("d1")).toEqual({ kind: "deploy-service", label: "Shop", href: `/apps/deploy/proj?service=${APP}` });
        expect(owned.get("p1")).toMatchObject({ kind: "dashboard", label: "polaris.example.test" });
        expect(owned.get("p2")).toMatchObject({ kind: "deploy-zone", label: "plr.example.test" });
        expect(owned.get("g1")).toMatchObject({ kind: "game-zone", label: "Minecraft" });
        expect(owned.get("v1")).toEqual({ kind: "verification", label: "brought.test", href: null });
    });

    it("leaves records Polaris did not write unmarked", async () => {
        const owned = await annotated();
        for (const id of ["v2", "mx", "ns", "spf", "x", "t1"]) expect(owned.get(id)).toBeNull();
    });

    it("reads each source once for the whole listing", async () => {
        await owners.loadOwnershipFacts(ZONE, records);
        expect(db.gameDnsRecord.findMany).toHaveBeenCalledTimes(1);
        expect(db.gameDnsRecord.findMany.mock.calls[0][0].where).toMatchObject({ zoneId: ZONE });
        expect(db.domain.findMany).toHaveBeenCalledTimes(1);
        expect(db.installedApp.findMany).toHaveBeenCalledTimes(1);
        expect(db.application.findMany).toHaveBeenCalledTimes(1);
    });
});

describe("the managed filter", () => {
    it("lists Polaris's records, or the rest", async () => {
        const owned = await annotated();
        const rows = records.map((record) => ({
            ...record,
            relative: record.name,
            ttl: 1,
            proxied: false,
            proxiable: false,
            priority: null,
            draft: null,
            ...(owned.get(record.id) ? { owner: owned.get(record.id)! } : {})
        }));
        const ids = (owned_: "polaris" | "other") =>
            view.listedRecords(rows, { ...view.NO_RECORD_FILTERS, owned: owned_ }).map((row) => row.id).sort();
        expect(ids("polaris")).toEqual(["cn1", "d1", "g1", "p1", "p2", "srv1", "v1"]);
        expect(ids("other")).toEqual(["mx", "ns", "spf", "t1", "v2", "x"]);
        expect(view.isNarrowed({ ...view.NO_RECORD_FILTERS, owned: "polaris" })).toBe(true);
        // A search finds a record by what it serves.
        expect(view.listedRecords(rows, { ...view.NO_RECORD_FILTERS, search: "survival" }).map((row) => row.id)).toContain("srv1");
    });
});

describe("the zone picker's pages", () => {
    const fetchMock = vi.fn();
    beforeEach(() => vi.stubGlobal("fetch", fetchMock));
    afterEach(() => vi.unstubAllGlobals());

    function answer(result: unknown) {
        fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({ success: true, result }) });
    }

    it("asks Cloudflare for one page, by name, narrowed by the search", async () => {
        const { listZonesPage } = await import("@/lib/integrations/cloudflare-api");
        answer([{ id: "a".repeat(32), name: "fjrg2007.com" }, { id: "b".repeat(32), name: "fjrg2007.net" }]);
        const page = await listZonesPage("tok", { query: " FJRG ", page: 3, perPage: 2 });
        const url = new URL(fetchMock.mock.calls[0][0] as string);
        expect(url.pathname.endsWith("/zones")).toBe(true);
        expect(url.searchParams.get("name")).toBe("contains:fjrg");
        expect(url.searchParams.get("page")).toBe("3");
        expect(url.searchParams.get("per_page")).toBe("2");
        expect(url.searchParams.get("order")).toBe("name");
        expect(page).toEqual({
            zones: [
                { id: "a".repeat(32), name: "fjrg2007.com" },
                { id: "b".repeat(32), name: "fjrg2007.net" }
            ],
            more: true
        });
    });

    it("says no page follows a short one, and never sends a name filter for an empty search", async () => {
        const { listZonesPage } = await import("@/lib/integrations/cloudflare-api");
        answer([{ id: "a".repeat(32), name: "one.test" }]);
        const page = await listZonesPage("tok", { query: "", page: 1, perPage: 25 });
        expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.has("name")).toBe(false);
        expect(page.more).toBe(false);
    });

    it("turns the picker's cursor into the next Cloudflare page, and resolves a picked id", async () => {
        const { zoneOptions } = await import("@/lib/dns/zone-records");
        answer([{ id: "a".repeat(32), name: "a.test" }, { id: "b".repeat(32), name: "b.test" }]);
        expect(await zoneOptions({ query: "test", cursor: "2", limit: 2 })).toEqual({
            items: [
                { id: "a".repeat(32), name: "a.test" },
                { id: "b".repeat(32), name: "b.test" }
            ],
            next: "3"
        });
        expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.get("page")).toBe("2");

        answer({ id: "c".repeat(32), name: "c.test" });
        expect(await zoneOptions({ query: "", cursor: null, limit: 25, ids: ["c".repeat(32), "not-an-id"] })).toEqual({
            items: [{ id: "c".repeat(32), name: "c.test" }],
            next: null
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
