/**
 * Opening the live console and typing into it, as the server takes them.
 *
 * Pinned: the socket ticket is only minted for somebody who holds
 * `games.console` - anybody else is refused and nothing is minted; a server the
 * socket cannot follow answers `follow: false`, so the console polls instead of
 * failing; and a line typed at the prompt still goes through the console's own
 * action, which writes the audit line before the server runs it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    requireGameServer: vi.fn(),
    mintConsoleTicket: vi.fn(),
    recordAudit: vi.fn(),
    runConsoleLine: vi.fn(),
    order: [] as string[]
}));

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/apps/install-access", () => ({
    requireGameServer: mocks.requireGameServer,
    gameServerAccess: vi.fn(),
    reachableInstallIds: vi.fn()
}));
vi.mock("@/lib/terminal-service", () => ({ mintConsoleTicket: mocks.mintConsoleTicket }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: mocks.recordAudit }));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    runConsoleLine: mocks.runConsoleLine,
    withServerContainer: vi.fn(),
    editionOf: () => "java",
    shownPlayers: async () => null
}));

const { openConsoleStreamAction } =
    await import("@polaris-app/game-servers/src/screens/installed/console-actions");
const { sendConsoleCommandAction } =
    await import("@polaris-app/game-servers/src/screens/installed/minecraft-actions");

const SERVER = "33333333-3333-4333-8333-333333333333";

function standing(applicationId: string | null = "app-1") {
    return {
        user: { id: "user-1" },
        access: {
            ownerId: "owner-1",
            install: { id: SERVER, catalogId: "minecraft", applicationId }
        }
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    mocks.requireGameServer.mockResolvedValue(standing());
    mocks.recordAudit.mockImplementation(async () => {
        mocks.order.push("audit");
    });
    mocks.runConsoleLine.mockImplementation(async () => {
        mocks.order.push("run");
        return "There are 0 of a max of 20 players online\n";
    });
});

describe("openConsoleStreamAction", () => {
    it("refuses somebody without games.console and mints nothing", async () => {
        mocks.requireGameServer.mockRejectedValue(new Error("You cannot use this server's console."));
        expect(await openConsoleStreamAction(SERVER)).toEqual({ refused: true });
        expect(mocks.requireGameServer).toHaveBeenCalledWith("games.console", SERVER);
        expect(mocks.mintConsoleTicket).not.toHaveBeenCalled();
    });

    it("refuses an id that is not a server's, without asking", async () => {
        expect(await openConsoleStreamAction("not-an-id")).toEqual({ refused: true });
        expect(mocks.requireGameServer).not.toHaveBeenCalled();
    });

    it("hands back a ticket minted for the caller, the owner and the server's application", async () => {
        mocks.mintConsoleTicket.mockResolvedValue("ticket-1");
        expect(await openConsoleStreamAction(SERVER)).toEqual({ token: "ticket-1" });
        expect(mocks.mintConsoleTicket).toHaveBeenCalledWith("user-1", "owner-1", "app-1");
    });

    it("falls back to polling for a server the socket cannot follow", async () => {
        mocks.mintConsoleTicket.mockResolvedValue(null);
        expect(await openConsoleStreamAction(SERVER)).toEqual({ follow: false });
    });

    it("falls back to polling when minting fails", async () => {
        mocks.mintConsoleTicket.mockRejectedValue(new Error("no sidecar"));
        expect(await openConsoleStreamAction(SERVER)).toEqual({ follow: false });
    });

    it("falls back to polling for a server with no application", async () => {
        mocks.requireGameServer.mockResolvedValue(standing(null));
        expect(await openConsoleStreamAction(SERVER)).toEqual({ follow: false });
        expect(mocks.mintConsoleTicket).not.toHaveBeenCalled();
    });
});

describe("a line typed in the live console", () => {
    it("is checked, audited before it runs, and answered", async () => {
        const reply = await sendConsoleCommandAction(SERVER, "  list  ");
        expect(mocks.requireGameServer).toHaveBeenCalledWith("games.console", SERVER);
        expect(mocks.recordAudit).toHaveBeenCalledWith({
            actorId: "user-1",
            action: "games.console",
            targetType: "installedApp",
            targetId: SERVER,
            metadata: { line: "list" }
        });
        expect(mocks.runConsoleLine).toHaveBeenCalledWith("owner-1", SERVER, "list");
        expect(mocks.order).toEqual(["audit", "run"]);
        expect(reply.output).toBe("There are 0 of a max of 20 players online");
        expect(reply.error).toBeUndefined();
    });

    it("runs nothing and audits nothing for somebody without games.console", async () => {
        mocks.requireGameServer.mockRejectedValue(new Error("You cannot use this server's console."));
        const reply = await sendConsoleCommandAction(SERVER, "op someone");
        expect(reply.error).toBeTruthy();
        expect(mocks.recordAudit).not.toHaveBeenCalled();
        expect(mocks.runConsoleLine).not.toHaveBeenCalled();
    });
});
