/**
 * Reading one player's bag for a screen or an assistant: live while they are on,
 * the copy kept last when they are not, and nothing at all for somebody who may
 * not see the server.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    findFirst: vi.fn(),
    upsert: vi.fn(),
    withServerContainer: vi.fn(),
    requireGameServer: vi.fn()
}));

vi.mock("@polaris/db", () => ({
    prisma: { playerInventorySnapshot: { findFirst: mocks.findFirst, upsert: mocks.upsert } }
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    withServerContainer: mocks.withServerContainer
}));
vi.mock("@/lib/apps/install-access", () => ({
    requireGameServer: mocks.requireGameServer,
    gameServerAccess: vi.fn(),
    reachableInstallIds: vi.fn()
}));

const { readPlayerInventory } =
    await import("@polaris-app/game-servers/src/lib/minecraft/inventory-service");
const { readPlayerInventoryAction } =
    await import("@polaris-app/game-servers/src/screens/installed/minecraft-actions");

const SERVER = "33333333-3333-4333-8333-333333333333";
const KEPT = {
    items: JSON.stringify([{ slot: 0, id: "minecraft:bow", count: 1, data: null }]),
    takenAt: new Date("2026-10-06T19:00:00.000Z")
};

/** A server that answers every command with the reply given for it. */
function answering(replies: Record<string, string>) {
    mocks.withServerContainer.mockImplementation(async (_owner, _id, run) =>
        run({ say: async (argv: readonly string[]) => replies[argv.join(" ")] ?? "" })
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirst.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({});
});

describe("readPlayerInventory", () => {
    it("reads the bag live and keeps it as the new copy", async () => {
        answering({
            "data get entity Steve Inventory":
                'Steve has the following entity data: [{Slot: 0b, id: "minecraft:bow", count: 1}]'
        });
        const read = await readPlayerInventory("owner-1", SERVER, "Steve");
        expect(read).toMatchObject({
            inventory: { live: true, items: [{ slot: 0, id: "minecraft:bow", count: 1 }] }
        });
        expect(mocks.upsert).toHaveBeenCalledTimes(1);
    });

    it("hands back the copy kept last when the player is not on", async () => {
        answering({ "data get entity Steve Inventory": "No entity was found" });
        mocks.findFirst.mockResolvedValue(KEPT);
        const read = await readPlayerInventory("owner-1", SERVER, "Steve");
        expect(read).toMatchObject({
            inventory: { live: false, takenAt: "2026-10-06T19:00:00.000Z" }
        });
        expect(mocks.upsert).not.toHaveBeenCalled();
    });

    it("says the player is not on when nothing was ever kept", async () => {
        answering({ "data get entity Steve Inventory": "No entity was found" });
        expect(await readPlayerInventory("owner-1", SERVER, "Steve")).toEqual({
            refusal: { reason: "offline" }
        });
    });

    it("says an old server has no way to read a bag", async () => {
        answering({
            "data get entity Steve Inventory": "Unknown or incomplete command, see below for error"
        });
        expect(await readPlayerInventory("owner-1", SERVER, "Steve")).toEqual({
            refusal: { reason: "unsupported" }
        });
    });

    it("falls back to the copy when the server cannot be reached, and throws without one", async () => {
        mocks.withServerContainer.mockRejectedValue(new Error("container is not running"));
        mocks.findFirst.mockResolvedValueOnce(KEPT);
        expect(await readPlayerInventory("owner-1", SERVER, "Steve")).toMatchObject({
            inventory: { live: false }
        });
        await expect(readPlayerInventory("owner-1", SERVER, "Steve")).rejects.toThrow(
            "container is not running"
        );
    });
});

describe("readPlayerInventoryAction", () => {
    it("never hands the kept copy to somebody who may not see the server", async () => {
        mocks.requireGameServer.mockRejectedValue(new Error("Server not found"));
        mocks.findFirst.mockResolvedValue(KEPT);
        const result = await readPlayerInventoryAction(SERVER, "Steve");
        expect(result.reading).toBeUndefined();
        expect(result.error).toBeTruthy();
        expect(mocks.findFirst).not.toHaveBeenCalled();
        expect(mocks.withServerContainer).not.toHaveBeenCalled();
    });

    it("reads through the shared reader for somebody who may", async () => {
        mocks.requireGameServer.mockResolvedValue({
            user: { id: "user-1" },
            access: { ownerId: "owner-1" }
        });
        answering({ "data get entity Steve Inventory": "No entity was found" });
        mocks.findFirst.mockResolvedValue(KEPT);
        const result = await readPlayerInventoryAction(SERVER, "Steve");
        expect(result.reading).toMatchObject({ live: false, items: [{ id: "minecraft:bow" }] });
        expect(mocks.withServerContainer).toHaveBeenCalledWith(
            "owner-1",
            SERVER,
            expect.anything()
        );
    });
});
