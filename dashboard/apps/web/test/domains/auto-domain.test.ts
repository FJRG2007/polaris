/**
 * The hostname a service gets. Two rules are protected here: on a REMOTE server that
 * server's own domain or address decides it, never the Polaris host's - a name built
 * from the wrong box resolves to a machine that is not running the service - and on
 * the Polaris host a zone is only used once its wildcard has been seen resolving here,
 * so a layout saved before its DNS exists does not hand out unreachable names.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("@polaris/db", () => ({
    prisma: {
        setting: {
            findUnique: async ({ where }: { where: { key: string } }) => {
                const value = store.get(where.key);
                return value === undefined ? null : { value };
            },
            upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
                store.set(where.key, create.value);
            },
            deleteMany: async ({ where }: { where: { key: string } }) => {
                store.delete(where.key);
            }
        }
    }
}));

const { resolveAutoDomain } = await import("../../src/lib/network-service");

describe("resolveAutoDomain for a remote server", () => {
    beforeEach(() => {
        store.clear();
    });

    it("uses the server's own wildcard domain, with a real certificate", async () => {
        const plan = await resolveAutoDomain("invoices", { ip: "51.15.20.30", wildcard: "apps.example.com" });
        expect(plan?.hostname.endsWith(".apps.example.com")).toBe(true);
        expect(plan).toMatchObject({ cert: "le", kind: "auto" });
    });

    it("prefers the wildcard over the address, so the name is not tied to an IP", async () => {
        const plan = await resolveAutoDomain("invoices", { ip: "192.168.1.20", wildcard: "apps.example.com" });
        expect(plan?.hostname).not.toContain("192-168-1-20");
        expect(plan?.kind).toBe("auto");
    });

    it("falls back to a public IP subdomain when the server has no domain", async () => {
        const plan = await resolveAutoDomain("invoices", { ip: "51.15.20.30" });
        expect(plan).toMatchObject({ cert: "le", kind: "auto" });
        expect(plan?.hostname).toContain("51-15-20-30.sslip.io");
    });

    it("marks a private-IP subdomain as LAN-only, served by the internal CA", async () => {
        const plan = await resolveAutoDomain("invoices", { ip: "192.168.1.20" });
        expect(plan).toMatchObject({ cert: "internal", kind: "lan" });
    });

    it("has nothing to offer for a server reached by name with no domain", async () => {
        expect(await resolveAutoDomain("invoices", { ip: "server.internal" })).toBeNull();
    });
});

describe("resolveAutoDomain on the Polaris host", () => {
    beforeEach(() => {
        store.clear();
        store.set(
            "domain.zones",
            JSON.stringify({
                baseDomain: "example.com",
                zones: [
                    { label: "polaris", scope: "polaris", primary: true },
                    { label: "plr", scope: "deploy", primary: true }
                ]
            })
        );
        store.set("domain.publicIp", "51.15.20.30");
        store.set("network.detectedPublicIp", "51.15.20.30");
        store.set("network.detectedPublicIpAt", String(Date.now()));
        // Answered, so nothing probes the network behind the classification.
        store.set("network.environment", "vps");
    });

    it("keeps new services on a free subdomain while the zone is unproven", async () => {
        const plan = await resolveAutoDomain("invoices");
        expect(plan?.hostname).toContain("51-15-20-30.sslip.io");
        expect(plan?.hostname).not.toContain("plr.example.com");
    });

    it("does not honour an unproven zone even when the mode was set by hand", async () => {
        store.set("network.mode", "wildcard");
        const plan = await resolveAutoDomain("invoices");
        expect(plan).toMatchObject({ cert: "le", kind: "auto" });
        expect(plan?.hostname).toContain("51-15-20-30.sslip.io");
    });

    it("mints in the deploy zone once its wildcard has been seen resolving here", async () => {
        store.set("domain.zones.verified", "1");
        const plan = await resolveAutoDomain("invoices");
        expect(plan?.hostname.endsWith(".plr.example.com")).toBe(true);
        expect(plan).toMatchObject({ cert: "le", kind: "auto" });
    });
});
