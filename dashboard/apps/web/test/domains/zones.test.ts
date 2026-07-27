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

/** What the Setting rows hold after a save, so a read sees what was written. Zones
 *  only mint hostnames once their DNS has been proven, so the flag is part of the
 *  fixture - `verified: false` is the "saved but not proven yet" state. */
function stored(value: unknown, verified = true): void {
    findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
        if (where.key === "domain.zones") return { value: JSON.stringify(value) };
        if (where.key === "domain.zones.verified") return verified ? { value: "1" } : null;
        return null;
    });
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

    it("drops a second zone of the same scope on the same hostname", async () => {
        const config = await saveDomainZones({
            baseDomain: "example.com",
            zones: [
                { label: "plr", scope: "deploy", primary: true },
                { label: "plr", scope: "deploy", primary: false }
            ]
        });
        expect(config.zones).toHaveLength(1);
    });

    it("keeps Polaris and deployed services on one hostname, sharing its wildcard", async () => {
        const config = await saveDomainZones({
            baseDomain: "example.com",
            zones: [
                { label: "", scope: "polaris", primary: true },
                { label: "", scope: "deploy", primary: true }
            ]
        });
        expect(config.zones).toHaveLength(2);
        expect(zoneRecords(config)).toEqual([
            { zone: config.zones[0], host: "example.com", wildcard: "*.example.com" }
        ]);
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
        expect(first).toMatchObject({ zoneHost: "plr.example.com" });
        expect(first).toHaveProperty("hostname", expect.stringMatching(/\.plr\.example\.com$/));
        expect(await deployHostname("invoices")).toEqual(first);
    });

    it("mints in another zone when asked, including the base domain", async () => {
        const minted = await deployHostname("invoices", { zoneLabel: "" });
        expect(minted).toMatchObject({ zoneHost: "example.com" });
        expect(minted).toHaveProperty("hostname", expect.stringMatching(/^[a-z0-9-]+\.example\.com$/));
    });

    it("mints an unguessable hostname on request", async () => {
        const random = await deployHostname("invoices", { random: true });
        expect(random).toHaveProperty("hostname", expect.stringMatching(/\.plr\.example\.com$/));
        expect(await deployHostname("invoices", { random: true })).not.toEqual(random);
    });

    it("lists the deploy zones for a picker, flagging the default", async () => {
        expect(await listDeployZones()).toEqual([
            { label: "plr", host: "plr.example.com", primary: true },
            { label: "", host: "example.com", primary: false }
        ]);
    });

    it("says a requested zone is gone, rather than blaming the setup", async () => {
        expect(await deployHostname("invoices", { zoneLabel: "deleted" })).toBe("unknown-zone");
    });

    it("has no hostname to offer when no domain is configured", async () => {
        findUnique.mockResolvedValue(null);
        expect(await deployHostname("invoices")).toBe("no-domain");
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

describe("the verification gate", () => {
    beforeEach(() => {
        findUnique.mockReset();
        stored(
            {
                baseDomain: "example.com",
                zones: [{ label: "plr", scope: "deploy", primary: true }]
            },
            false
        );
    });

    it("mints no hostname on a layout whose DNS has never been seen working", async () => {
        expect(await deployHostname("invoices")).toBe("unverified");
    });

    it("offers no zone in the picker either, so it cannot be the default there", async () => {
        expect(await listDeployZones()).toEqual([]);
    });
});
