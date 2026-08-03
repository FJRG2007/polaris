/**
 * The subdomain a zone hostname takes. It is what the operator sees in the field
 * before pressing Add, so the cases that matter are the ones that would offer a name
 * that cannot be created: the service's own name when something already answers on
 * it, and a name typed while another service holds it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const findFirst = vi.fn();
const count = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        setting: { findUnique, upsert: vi.fn(), deleteMany: vi.fn() },
        application: { findFirst },
        domain: { count, findFirst: vi.fn(), findMany: vi.fn() }
    }
}));

// Reaching the deploy service pulls in the modules that read linked accounts,
// and those validate the runtime environment as they load. None of it is asked
// anything here, so a stand-in is enough to let the import through.
vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_MASTER_KEY: "test-key", POLARIS_DATA_DIR: "/tmp/polaris" }),
    getCapabilities: () => ({})
}));

const { checkZoneSubdomain } = await import("../../src/lib/deploy-service");

/** A configured, DNS-proven zone layout - the state a hostname can be minted in. */
function zonesConfigured(): void {
    findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
        if (where.key === "domain.zones") {
            return {
                value: JSON.stringify({
                    baseDomain: "example.com",
                    zones: [{ label: "plr", scope: "deploy", primary: true }]
                })
            };
        }
        if (where.key === "domain.zones.verified") return { value: "1" };
        return null;
    });
}

describe("checkZoneSubdomain", () => {
    beforeEach(() => {
        findUnique.mockReset();
        findFirst.mockReset();
        count.mockReset();
        zonesConfigured();
        findFirst.mockResolvedValue({ slug: "invoices" });
    });

    it("proposes the service's own name when it is free", async () => {
        count.mockResolvedValue(0);
        expect(await checkZoneSubdomain("app-1", "owner-1", {})).toEqual({
            subdomain: "invoices",
            hostname: "invoices.plr.example.com",
            available: true
        });
    });

    it("proposes a name that is actually free when the obvious one is taken", async () => {
        count.mockResolvedValueOnce(1).mockResolvedValue(0);
        const result = await checkZoneSubdomain("app-1", "owner-1", {});
        expect(result).toMatchObject({ available: true });
        expect(result).toHaveProperty("subdomain", expect.stringMatching(/^invoices-[0-9a-f]{4}$/));
    });

    it("says a typed name is taken instead of quietly picking another", async () => {
        count.mockResolvedValue(1);
        expect(await checkZoneSubdomain("app-1", "owner-1", { subdomain: "billing" })).toEqual({
            subdomain: "billing",
            hostname: "billing.plr.example.com",
            available: false
        });
    });

    it("flags a typed name with no DNS label in it", async () => {
        count.mockResolvedValue(0);
        expect(await checkZoneSubdomain("app-1", "owner-1", { subdomain: "!!!" })).toMatchObject({
            available: false,
            invalid: true
        });
    });

    it("reports why nothing can be minted when the zone is not proven yet", async () => {
        findUnique.mockResolvedValue(null);
        expect(await checkZoneSubdomain("app-1", "owner-1", {})).toBe("no-domain");
    });

    it("refuses a service the caller does not own", async () => {
        findFirst.mockResolvedValue(null);
        await expect(checkZoneSubdomain("app-1", "someone-else", {})).rejects.toThrow(/not found/i);
    });
});
