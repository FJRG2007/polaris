/**
 * Turning the VPN on takes the hostname the screen showed. With no zone sent, the
 * name lands where the picker defaults to: the primary zone, or the first one
 * offered when none is primary. An empty label names a different zone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    addApplicationDomain: vi.fn(),
    listDeployZones: vi.fn()
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: async ({ where }: { where: { catalogId: string } }) =>
                where.catalogId === "vpn"
                    ? { id: "install-1", config: null }
                    : {
                          id: "engine-1",
                          ownerId: "owner-1",
                          applicationId: "app-1",
                          status: "failed"
                      }
        }
    }
}));
vi.mock("@/lib/deploy-service", () => ({ addApplicationDomain: mocks.addApplicationDomain }));
vi.mock("@/lib/domain-zones", () => ({ listDeployZones: mocks.listDeployZones }));
vi.mock("@/lib/apps/install-service", () => ({ installApp: vi.fn(), uninstallApp: vi.fn() }));
vi.mock("@/lib/env-var-service", () => ({ setEnvVar: vi.fn() }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: vi.fn() }));
vi.mock("@/lib/host-address", () => ({ getHostLanIp: vi.fn() }));
vi.mock("@/lib/deploy/host-port", () => ({ hostPortForApp: vi.fn() }));
vi.mock("@/lib/dns-blocker/service", () => ({ dnsBlockerStatus: vi.fn() }));
vi.mock("@/lib/deploy/runtime", () => ({ getPorts: vi.fn() }));
vi.mock("@/lib/container-files-service", () => ({ resolveContainerName: vi.fn() }));
vi.mock("@/lib/tls/managed-certificates", () => ({ openText: vi.fn(), sealText: vi.fn() }));
vi.mock("@/lib/apps/install-config", () => ({
    patchInstallConfig: vi.fn(),
    readInstallConfig: () => ({})
}));
vi.mock("@/lib/vpn/edge", () => ({ syncVpnEdge: vi.fn() }));

const service = await import("@/lib/vpn/service");

/** Where the assertion is made, so nothing past the hostname has to be faked. */
const STOP = new Error("stop here");

describe("turning the VPN on", () => {
    beforeEach(() => {
        mocks.addApplicationDomain.mockReset().mockRejectedValue(STOP);
        mocks.listDeployZones.mockReset().mockResolvedValue([
            { label: "extra", host: "extra.example.test", primary: false },
            { label: "plr", host: "plr.example.test", primary: true }
        ]);
    });

    function zoneAsked(): unknown {
        return mocks.addApplicationDomain.mock.calls[0]?.[2]?.zoneLabel;
    }

    it("takes the primary zone when none was picked", async () => {
        await expect(service.turnOn("owner-1", { subdomain: "vpn" })).rejects.toBe(STOP);
        expect(zoneAsked()).toBe("plr");
    });

    it("takes the first zone offered when none is primary", async () => {
        mocks.listDeployZones.mockResolvedValue([
            { label: "~base", host: "example.test", primary: false }
        ]);
        await expect(service.turnOn("owner-1", { subdomain: "vpn" })).rejects.toBe(STOP);
        expect(zoneAsked()).toBe("~base");
    });

    it("takes the zone that was picked, an empty label included", async () => {
        await expect(
            service.turnOn("owner-1", { zoneLabel: "extra", subdomain: "vpn" })
        ).rejects.toBe(STOP);
        expect(zoneAsked()).toBe("extra");
        mocks.addApplicationDomain.mockClear();
        await expect(service.turnOn("owner-1", { zoneLabel: "", subdomain: "vpn" })).rejects.toBe(
            STOP
        );
        expect(zoneAsked()).toBe("");
    });
});
