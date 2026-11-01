/**
 * What a gateway does when part of the world is missing: a dead server still loses
 * its VPN access, a network saved on one is reported rather than failed, and the
 * list opens one connection per server.
 */

import type { PrivateNetwork } from "@/lib/vpn/networks";
import { beforeEach, describe, expect, it, vi } from "vitest";

const vpn = vi.hoisted(() => {
    class VpnRefusal extends Error {
        constructor(readonly code: string) {
            super(code);
        }
    }
    return {
        VpnRefusal,
        storedNetworks: vi.fn(),
        saveNetworks: vi.fn(),
        applyNetworkAccess: vi.fn(),
        allNodes: vi.fn(),
        gatewayKey: vi.fn(),
        approveGatewayRoutes: vi.fn(),
        removeGatewayNode: vi.fn(),
        onNetworkServer: vi.fn()
    };
});

vi.mock("@/lib/vpn/service", () => vpn);
vi.mock("@polaris/config", () => ({ getCapabilities: () => ({ deploy: true }) }));
vi.mock("@/lib/tls/managed-certificates", () => ({
    openText: (value: string) => value,
    sealText: (value: string) => value
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        deployTarget: {
            findFirst: async () => ({ id: "target-1", ownerId: "owner-1" }),
            findMany: async () => []
        }
    }
}));

const service = await import("@/lib/vpn/network-service");
const { gatewayName } = await import("@/lib/vpn/networks");

const ACTOR = { id: "owner-1", name: "Fixture", email: "fixture@example.test" };
const NODE = {
    id: "node-1",
    givenName: gatewayName("target-1"),
    tags: ["tag:polaris"],
    online: true,
    availableRoutes: ["10.77.0.0/24"],
    approvedRoutes: ["10.77.0.0/24"]
};
const NETWORK: PrivateNetwork = {
    id: "0190f1c2-0000-7000-8000-000000000001",
    name: "Fixture home",
    cidr: "10.77.0.0/24",
    routerAddress: "10.77.0.1",
    targetId: "target-1",
    targetOwnerId: "owner-1",
    ssid: "Fixture wifi",
    wifiPassword: "sealed",
    access: "admins",
    internet: false,
    createdAt: "2026-11-01T00:00:00.000Z"
};
const INPUT = {
    name: "Other",
    cidr: "10.77.1.0/24",
    routerAddress: "10.77.1.1",
    targetId: "target-1",
    ssid: "Other",
    access: "admins" as const,
    internet: false
};

beforeEach(() => {
    vi.clearAllMocks();
    vpn.storedNetworks.mockResolvedValue([NETWORK]);
    vpn.saveNetworks.mockResolvedValue(undefined);
    vpn.applyNetworkAccess.mockResolvedValue(undefined);
    vpn.allNodes.mockResolvedValue([NODE]);
    vpn.gatewayKey.mockResolvedValue({ loginServer: "https://vpn.example.test", authKey: "key" });
    vpn.approveGatewayRoutes.mockResolvedValue(undefined);
    vpn.removeGatewayNode.mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("removing a network on a dead server", () => {
    it("still takes the gateway off the VPN", async () => {
        vpn.onNetworkServer.mockRejectedValue(new Error("unreachable"));
        await service.removeNetwork(ACTOR, NETWORK.id);
        expect(vpn.saveNetworks).toHaveBeenCalledWith([]);
        expect(vpn.removeGatewayNode).toHaveBeenCalledWith("node-1");
    });

    it("still stops the container when the VPN refuses to delete the device", async () => {
        vpn.onNetworkServer.mockResolvedValue(undefined);
        vpn.removeGatewayNode.mockRejectedValue(new Error("refused"));
        await service.removeNetwork(ACTOR, NETWORK.id);
        expect(vpn.onNetworkServer).toHaveBeenCalledTimes(1);
    });

    it("clears the gateway even when the policy could not be written", async () => {
        vpn.onNetworkServer.mockResolvedValue(undefined);
        vpn.applyNetworkAccess.mockRejectedValue(new Error("refused"));
        await service.removeNetwork(ACTOR, NETWORK.id);
        expect(vpn.removeGatewayNode).toHaveBeenCalledWith("node-1");
    });

    it("withdraws only the removed route when others stay on that server", async () => {
        const second = {
            ...NETWORK,
            id: "0190f1c2-0000-7000-8000-000000000002",
            cidr: "10.77.1.0/24"
        };
        vpn.storedNetworks.mockResolvedValue([NETWORK, second]);
        vpn.allNodes.mockResolvedValue([
            { ...NODE, approvedRoutes: ["10.77.0.0/24", "10.77.1.0/24"] }
        ]);
        vpn.onNetworkServer.mockRejectedValue(new Error("unreachable"));
        await service.removeNetwork(ACTOR, NETWORK.id);
        expect(vpn.approveGatewayRoutes).toHaveBeenCalledWith("node-1", ["10.77.1.0/24"]);
    });
});

describe("creating a network", () => {
    it("reports a gateway that did not start instead of failing what was saved", async () => {
        vpn.onNetworkServer.mockRejectedValue(new Error("unreachable"));
        const { network, problem } = await service.createNetwork(ACTOR, INPUT);
        expect(vpn.saveNetworks).toHaveBeenCalledTimes(1);
        expect(network.cidr).toBe(INPUT.cidr);
        expect(problem?.code).toBe("gatewayFailed");
    });

    it("reports a policy that was not written, and Retry writes it", async () => {
        vpn.applyNetworkAccess.mockRejectedValueOnce(new Error("refused"));
        const { problem } = await service.createNetwork(ACTOR, INPUT);
        expect(problem?.code).toBe("gatewayFailed");
        vpn.onNetworkServer.mockResolvedValue(undefined);
        await service.retryGateway(ACTOR, NETWORK.id);
        expect(vpn.applyNetworkAccess).toHaveBeenCalledTimes(2);
    });

    it("has no problem to report when everything came up", async () => {
        vpn.onNetworkServer.mockResolvedValue(undefined);
        expect((await service.createNetwork(ACTOR, INPUT)).problem).toBeNull();
    });
});

describe("the list", () => {
    it("asks one server about all its routers over one connection", async () => {
        const second = {
            ...NETWORK,
            id: "0190f1c2-0000-7000-8000-000000000002",
            cidr: "10.77.1.0/24",
            routerAddress: "10.77.1.1"
        };
        vpn.storedNetworks.mockResolvedValue([NETWORK, second]);
        vpn.allNodes.mockResolvedValue([
            {
                ...NODE,
                availableRoutes: ["10.77.0.0/24", "10.77.1.0/24"],
                approvedRoutes: ["10.77.0.0/24", "10.77.1.0/24"]
            }
        ]);
        const runIn = vi.fn(async (_service: string, argv: readonly string[]) => ({
            code: argv.includes("10.77.0.1") ? 0 : 1
        }));
        vpn.onNetworkServer.mockImplementation((_network, work) => work({ runIn }));
        const list = await service.listNetworks({ id: "owner-1", isAdmin: true });
        expect(vpn.onNetworkServer).toHaveBeenCalledTimes(1);
        expect(runIn).toHaveBeenCalledTimes(2);
        expect(list.map(({ routerReachable }) => routerReachable)).toEqual([true, false]);
    });

    it("opens no connection for a member", async () => {
        const shared = { ...NETWORK, access: "everyone" as const };
        vpn.storedNetworks.mockResolvedValue([shared]);
        const list = await service.listNetworks({ id: "member-1", isAdmin: false });
        expect(vpn.onNetworkServer).not.toHaveBeenCalled();
        expect(list[0]?.routerReachable).toBeNull();
        expect(list[0]?.setup).toBeNull();
    });
});
