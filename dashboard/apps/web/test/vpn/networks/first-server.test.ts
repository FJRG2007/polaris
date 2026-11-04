/**
 * The network dialog opens on one server and pages the rest through the picker:
 * the answer it is given is one bounded read, never the server list.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const capabilities = vi.hoisted(() => ({ deploy: true }));
const findFirst = vi.fn();
const findMany = vi.fn();

vi.mock("@/lib/vpn/service", () => ({ VpnRefusal: class extends Error {} }));
vi.mock("@polaris/config", () => ({ getCapabilities: () => capabilities }));
vi.mock("@/lib/tls/managed-certificates", () => ({
    openText: (value: string) => value,
    sealText: (value: string) => value
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        deployTarget: {
            findFirst: (...args: unknown[]) => findFirst(...args),
            findMany: (...args: unknown[]) => findMany(...args)
        }
    }
}));

const service = await import("@/lib/vpn/network-service");

beforeEach(() => {
    findFirst.mockReset();
    findMany.mockReset();
    capabilities.deploy = true;
});

describe("firstNetworkServer", () => {
    it("reads one of the owner's active servers, in the picker's order", async () => {
        findFirst.mockResolvedValue({ id: "target-1", name: "fixture-server" });
        expect(await service.firstNetworkServer("owner-1")).toEqual({
            id: "target-1",
            name: "fixture-server"
        });
        expect(findFirst).toHaveBeenCalledWith({
            where: { ownerId: "owner-1", status: "active" },
            select: { id: true, name: true },
            orderBy: [{ name: "asc" }, { id: "asc" }]
        });
        expect(findMany).not.toHaveBeenCalled();
    });

    it("reads nothing where this edition cannot run a gateway", async () => {
        capabilities.deploy = false;
        expect(await service.firstNetworkServer("owner-1")).toBeNull();
        expect(findFirst).not.toHaveBeenCalled();
    });
});
