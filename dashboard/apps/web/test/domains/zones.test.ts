/**
 * The stored zone layout. It is the single source of truth for every hostname
 * Polaris mints on a configured domain, so the cases here are the ones that would
 * hand out a URL nobody can reach: two zones fighting over one hostname, more than
 * one default per scope, a layout with nowhere to put deployed services, and a
 * stored value an older or hand-edited install left behind.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const upsert = vi.fn();
const deleteMany = vi.fn();

vi.mock("@polaris/db", () => ({ prisma: { setting: { findUnique, upsert, deleteMany } } }));

const { deployHostname, deployZoneBase, getDomainZones, listDeployZones, saveDomainZones, zoneRecords } = await import(
    "../../src/lib/domain-zones"
);

/** What the Setting row holds after a save, so a read sees what was written. */
function stored(value: unknown): void {
    findUnique.mockResolvedValue({ value: JSON.stringify(value) });
}

describe("saveDomainZones", () => {
    beforeEach(() => {
        findUnique.mockReset();
        upsert.mockReset();
        deleteMany.mockReset();
        findUnique.mockResolvedValue(null);
    });

    it("normalizes what the operator typed", async () => {
        const config = await saveDomainZones({
            baseDomain: "HTTPS://*.Example.com/",
            zones: [{ label: "PLR", scope: "deploy", primary: true }]
        });
        expect(config.baseDomain).toBe("example.com");
        expect(config.zones[0]?.label).toBe("plr");
    });

    it("keeps one default per scope", async () => {
        const config = await saveDomainZones({
            baseDomain: "example.com",
            zones: [
                { label: "plr", scope: "deploy", primary: true },
                { label: "apps", scope: "deploy", primary: true }
            ]
        });
        expect(config.zones.filter((zone) => zone.primary)).toHaveLength(1);
        expect(config.zones.find((zone) => zone.primary)?.label).toBe("plr");
    });

    it("drops a second zone on the same hostname", async () => {
        const config = await saveDomainZones({
            baseDomain: "example.com",
            zones: [
                { label: "plr", scope: "deploy", primary: true },
                { label: "plr", scope: "polaris", primary: true }
            ]
        });
        expect(config.zones).toHaveLength(1);
    });

    it("refuses a domain with nowhere to put deployed services", async () => {
        await expect(
            saveDomainZones({ baseDomain: "example.com", zones: [{ label: "polaris", scope: "polaris", primary: true }] })
        ).rejects.toThrow(/deployed services/i);
    });

    it("refuses a label that is not a single DNS label", async () => {
        await expect(
            saveDomainZones({ baseDomain: "example.com", zones: [{ label: "a.b", scope: "deploy", primary: true }] })
        ).rejects.toThrow();
    });

    it("refuses something that is not a domain", async () => {
        await expect(saveDomainZones({ baseDomain: "localhost", zones: [] })).rejects.toThrow(/example\.com/);
    });

    it("accepts no domain at all, for the free-subdomain setup", async () => {
        const config = await saveDomainZones({ baseDomain: "", zones: [] });
        expect(config.baseDomain).toBe("");
    });
});

describe("getDomainZones", () => {
    beforeEach(() => {
        findUnique.mockReset();
        upsert.mockReset();
    });

    it("offers the defaults when nothing has been configured", async () => {
        findUnique.mockResolvedValue(null);
        const config = await getDomainZones();
        expect(config.baseDomain).toBe("");
        expect(config.zones.map((zone) => zone.label)).toEqual(["polaris", "plr"]);
    });

    it("treats an unreadable stored value as unconfigured rather than trusting it", async () => {
        findUnique.mockResolvedValue({ value: "{not json" });
        expect((await getDomainZones()).baseDomain).toBe("");
        findUnique.mockResolvedValue({ value: JSON.stringify({ baseDomain: "example.com", zones: "nope" }) });
        expect((await getDomainZones()).baseDomain).toBe("");
    });
});

describe("hostnames minted from the layout", () => {
    beforeEach(() => {
        findUnique.mockReset();
        stored({
            baseDomain: "example.com",
            zones: [
                { label: "polaris", scope: "polaris", primary: true },
                { label: "plr", scope: "deploy", primary: true },
                { label: "", scope: "deploy", primary: false }
            ]
        });
    });

    it("uses the default deploy zone as the wildcard base", async () => {
        expect(await deployZoneBase()).toBe("plr.example.com");
    });

    it("mints a stable hostname in the default zone", async () => {
        const first = await deployHostname("invoices");
        expect(first).toMatch(/\.plr\.example\.com$/);
        expect(await deployHostname("invoices")).toBe(first);
    });

    it("mints in another zone when asked, including the base domain", async () => {
        expect(await deployHostname("invoices", { zoneLabel: "" })).toMatch(/^[a-z0-9-]+\.example\.com$/);
    });

    it("mints an unguessable hostname on request", async () => {
        const random = await deployHostname("invoices", { random: true });
        expect(random).toMatch(/\.plr\.example\.com$/);
        expect(await deployHostname("invoices", { random: true })).not.toBe(random);
    });

    it("lists the deploy zones for a picker", async () => {
        expect(await listDeployZones()).toEqual([
            { label: "plr", host: "plr.example.com" },
            { label: "", host: "example.com" }
        ]);
    });

    it("has no hostname to offer when no domain is configured", async () => {
        findUnique.mockResolvedValue(null);
        expect(await deployHostname("invoices")).toBeNull();
        expect(await deployZoneBase()).toBeNull();
    });
});

describe("zoneRecords", () => {
    it("names the pair of records each zone needs", () => {
        const records = zoneRecords({
            baseDomain: "example.com",
            zones: [{ label: "plr", scope: "deploy", primary: true }]
        });
        expect(records).toEqual([
            {
                zone: { label: "plr", scope: "deploy", primary: true },
                host: "plr.example.com",
                wildcard: "*.plr.example.com"
            }
        ]);
    });

    it("asks for nothing when there is no domain", () => {
        expect(zoneRecords({ baseDomain: "", zones: [] })).toEqual([]);
    });
});
