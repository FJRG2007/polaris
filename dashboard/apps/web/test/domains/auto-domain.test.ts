/**
 * The hostname a service on a REMOTE server gets. The rule being protected: that
 * server's own domain or address decides it, never the Polaris host's - a name
 * built from the wrong box resolves to a machine that is not running the service.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();

vi.mock("@polaris/db", () => ({ prisma: { setting: { findUnique, upsert: vi.fn(), deleteMany: vi.fn() } } }));

const { resolveAutoDomain } = await import("../../src/lib/network-service");

describe("resolveAutoDomain for a remote server", () => {
    beforeEach(() => {
        findUnique.mockReset();
        findUnique.mockResolvedValue(null);
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
