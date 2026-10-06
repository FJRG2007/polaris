/**
 * The Game servers tools for players, announcements, restarts and worlds, and
 * players in `polaris_search`, called the way an MCP client calls them.
 *
 * What is pinned is the boundary with the screens: each tool asks for the same
 * standing on that server as the button it stands for (`games.moderate` for a
 * kick, `games.manage` for who may join and for a restore, `games.console` for
 * an announcement), goes through the same function, and leaves the same audit
 * line marked as an assistant's. Moderation is a scope of its own, which the
 * managing scope does not carry, and a restore must be confirmed in the call.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    actingUser: vi.fn(),
    recordAudit: vi.fn(),
    gameServerAccess: vi.fn(),
    reachableInstallIds: vi.fn(),
    listGameServerFacts: vi.fn(),
    listGameServerPresence: vi.fn(),
    moderatePlayer: vi.fn(),
    moderateArkPlayer: vi.fn(),
    timeoutPlayer: vi.fn(),
    liftTimeout: vi.fn(),
    timeoutArkPlayer: vi.fn(),
    liftArkTimeout: vi.fn(),
    readPlayerTimeouts: vi.fn(),
    runServerCommand: vi.fn(),
    getServerRoster: vi.fn(),
    listPlayerAccess: vi.fn(),
    forViewer: vi.fn(),
    grantPlayerAccess: vi.fn(),
    revokePlayerAccess: vi.fn(),
    announceNow: vi.fn(),
    listTemplates: vi.fn(),
    saveTemplate: vi.fn(),
    deleteTemplate: vi.fn(),
    readRestartRequest: vi.fn(),
    requestRestart: vi.fn(),
    cancelRestart: vi.fn(),
    getGameSchedule: vi.fn(),
    readWorldView: vi.fn(),
    createWorldBackup: vi.fn(),
    restoreWorldBackup: vi.fn(),
    searchKnownPlayers: vi.fn()
}));

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/mcp/acting-user", () => ({ actingUser: mocks.actingUser }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: mocks.recordAudit }));
vi.mock("@/lib/i18n/request", () => ({ getLocale: async () => "en-US" }));
vi.mock("@/lib/apps/install-access", () => ({
    gameServerAccess: mocks.gameServerAccess,
    reachableInstallIds: mocks.reachableInstallIds
}));
vi.mock("@polaris-app/game-servers/src/lib/games-service", () => ({
    listGameServerFacts: mocks.listGameServerFacts,
    listGameServerPresence: mocks.listGameServerPresence,
    withNamesOnly: (presence: { players: { name: string }[] }) => ({
        ...presence,
        players: presence.players.map((player) => player.name)
    })
}));
vi.mock("@polaris-app/game-servers/src/lib/games-operations", () => ({
    setServerRunning: vi.fn(),
    restartServerNow: vi.fn(),
    runConsoleCommand: vi.fn()
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/player-moderation", () => ({
    moderatePlayer: mocks.moderatePlayer
}));
vi.mock("@polaris-app/game-servers/src/lib/ark/player-moderation", () => ({
    moderateArkPlayer: mocks.moderateArkPlayer
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/timeout-service", () => ({
    timeoutPlayer: mocks.timeoutPlayer,
    liftTimeout: mocks.liftTimeout
}));
vi.mock("@polaris-app/game-servers/src/lib/ark/timeout-service", () => ({
    timeoutArkPlayer: mocks.timeoutArkPlayer,
    liftArkTimeout: mocks.liftArkTimeout
}));
vi.mock("@polaris-app/game-servers/src/lib/player-timeout-service", () => ({
    readPlayerTimeouts: mocks.readPlayerTimeouts
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    getServerRoster: mocks.getServerRoster,
    runServerCommand: mocks.runServerCommand
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/player-access", () => ({
    listPlayerAccess: mocks.listPlayerAccess,
    forViewer: mocks.forViewer,
    grantPlayerAccess: mocks.grantPlayerAccess,
    revokePlayerAccess: mocks.revokePlayerAccess
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/live-display-service", () => ({
    announceNow: mocks.announceNow
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/announcement-template-service", () => ({
    listTemplates: mocks.listTemplates,
    saveTemplate: mocks.saveTemplate,
    deleteTemplate: mocks.deleteTemplate
}));
vi.mock("@polaris-app/game-servers/src/lib/games-restart-service", () => ({
    readRestartRequest: mocks.readRestartRequest,
    requestRestart: mocks.requestRestart,
    cancelRestart: mocks.cancelRestart
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/schedule-service", () => ({
    getGameSchedule: mocks.getGameSchedule
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/world-service", () => ({
    readWorldView: mocks.readWorldView,
    createWorldBackup: mocks.createWorldBackup,
    restoreWorldBackup: mocks.restoreWorldBackup
}));
vi.mock("@polaris-app/game-servers/src/lib/games-activity-service", () => ({
    searchKnownPlayers: mocks.searchKnownPlayers
}));

const { gameServersExtension } = await import("@polaris-app/game-servers/src/lib/games-extension");
const { handleMcpMessage } = await import("@/lib/mcp/protocol");

const TOOLS = [...(await gameServersExtension.mcpTools!())];
const SERVER = { name: "polaris", version: "1", instructions: "" };
const ADA = { id: "user-1", email: "ada@example.test", name: "Ada", isAdmin: false, sessionId: "" };
const GAME = "33333333-3333-4333-8333-333333333333";
const STEAM = "76561198000000000";
const BACKUP = "2026-10-06T10-00-00-000.tar.gz";

type ToolResult = { content: { text: string }[]; isError?: boolean; structuredContent?: any };

async function call(name: string, args: Record<string, unknown>, scopes: string[]) {
    const reply = await handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        TOOLS,
        { userId: "user-1", isAdmin: false, scopes: scopes as never, grantId: "grant-1" },
        SERVER
    );
    // A call whose arguments do not fit the tool's schema is refused by the
    // protocol itself, before the tool runs.
    if (reply && "error" in reply && reply.error)
        return { isError: true, content: [{ text: String(reply.error.message) }] } as ToolResult;
    return reply?.result as ToolResult;
}

function standing(catalogId = "minecraft") {
    return {
        ownerId: "owner-1",
        isOwner: false,
        install: {
            id: GAME,
            name: "Survival",
            catalogId,
            applicationId: "app-1",
            status: "running"
        }
    };
}

const audited = (action: string) =>
    expect(mocks.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
            actorId: "user-1",
            action,
            targetId: GAME,
            metadata: expect.objectContaining({ via: "mcp" })
        })
    );

beforeEach(() => {
    vi.clearAllMocks();
    mocks.actingUser.mockResolvedValue(ADA);
    mocks.gameServerAccess.mockResolvedValue(standing());
    mocks.moderatePlayer.mockResolvedValue("Kicked Steve");
    mocks.readPlayerTimeouts.mockResolvedValue([]);
    mocks.timeoutPlayer.mockResolvedValue({ player: "Steve", until: "2026-10-06T12:00:00.000Z" });
    mocks.timeoutArkPlayer.mockResolvedValue({ player: STEAM, until: "2026-10-06T12:00:00.000Z" });
    mocks.listTemplates.mockResolvedValue([]);
    mocks.announceNow.mockResolvedValue({ sent: 3, kept: false });
    mocks.requestRestart.mockImplementation(
        async (_id: string, input: { when: string; at: string | null; reason: string }) => ({
            ...input,
            requestedAt: "2026-10-06T10:00:00.000Z",
            requestedBy: "user-1"
        })
    );
    mocks.restoreWorldBackup.mockResolvedValue({ level: "world-restored" });
    mocks.createWorldBackup.mockResolvedValue({
        name: BACKUP,
        sizeBytes: 1024,
        createdAt: "2026-10-06T10:00:00.000Z"
    });
});

describe("moderating players", () => {
    it("kicks through the Players tab's own route, on the moderator standing, and records it", async () => {
        const result = await call(
            "games_player_moderate",
            { serverId: GAME, player: "Steve", action: "kick", reason: "Spam" },
            ["gameservers.moderate"]
        );
        expect(result.isError).toBeUndefined();
        expect(mocks.gameServerAccess).toHaveBeenCalledWith(ADA, GAME, "games.moderate");
        expect(mocks.moderatePlayer).toHaveBeenCalledWith("owner-1", GAME, {
            action: "kick",
            player: "Steve",
            reason: "Spam"
        });
        audited("minecraft.kick");
    });

    it("is its own scope: neither reading nor managing a server reaches it", async () => {
        for (const scope of ["gameservers.read", "gameservers.manage"]) {
            const refused = await call(
                "games_player_moderate",
                { serverId: GAME, player: "Steve", action: "ban" },
                [scope]
            );
            expect(refused.isError).toBe(true);
            expect(refused.content[0]?.text).toContain("gameservers.moderate");
        }
        expect(mocks.moderatePlayer).not.toHaveBeenCalled();
    });

    it("refuses a name Minecraft would not have, and a server the person cannot moderate", async () => {
        const bad = await call(
            "games_player_moderate",
            { serverId: GAME, player: "not a name!", action: "kick" },
            ["gameservers.moderate"]
        );
        expect(bad.content[0]?.text).toContain("1 to 16 letters");
        mocks.gameServerAccess.mockResolvedValue(null);
        const unseen = await call(
            "games_player_moderate",
            { serverId: GAME, player: "Steve", action: "kick" },
            ["gameservers.moderate"]
        );
        expect(unseen.content[0]?.text).toContain("cannot do that");
        expect(mocks.moderatePlayer).not.toHaveBeenCalled();
    });

    it("pardons an ARK survivor by SteamID64, as the ARK panel does", async () => {
        mocks.gameServerAccess.mockResolvedValue(standing("ark"));
        await call("games_player_moderate", { serverId: GAME, player: STEAM, action: "pardon" }, [
            "gameservers.moderate"
        ]);
        expect(mocks.moderateArkPlayer).toHaveBeenCalledWith("owner-1", GAME, STEAM, "unban");
        audited("games.ark.unban");
        const named = await call(
            "games_player_moderate",
            { serverId: GAME, player: "Steve", action: "kick" },
            ["gameservers.moderate"]
        );
        expect(named.content[0]?.text).toContain("SteamID64");
    });

    it("times a player out and lets them back early", async () => {
        const out = await call(
            "games_player_timeout",
            { serverId: GAME, player: "Steve", minutes: 30 },
            ["gameservers.moderate"]
        );
        expect(mocks.timeoutPlayer).toHaveBeenCalledWith("owner-1", GAME, "Steve", 30, undefined);
        expect(out.structuredContent).toMatchObject({ until: "2026-10-06T12:00:00.000Z" });
        audited("minecraft.timeout");
        await call("games_player_timeout", { serverId: GAME, player: "Steve", lift: true }, [
            "gameservers.moderate"
        ]);
        expect(mocks.liftTimeout).toHaveBeenCalledWith("owner-1", GAME, "Steve");
        audited("minecraft.timeout-lift");
    });

    it("switches the whitelist on through the console command the tab sends", async () => {
        mocks.runServerCommand.mockResolvedValue("Whitelist is now turned on");
        await call("games_whitelist", { serverId: GAME, enforced: true }, ["gameservers.moderate"]);
        expect(mocks.runServerCommand).toHaveBeenCalledWith("owner-1", GAME, ["whitelist", "on"]);
        audited("minecraft.whitelist-enforce");
    });
});

describe("who may join", () => {
    it("lets a player in only on the managing standing, and asks where from", async () => {
        const missing = await call(
            "games_player_access",
            { serverId: GAME, action: "grant", username: "Steve" },
            ["gameservers.manage"]
        );
        expect(missing.content[0]?.text).toContain("connect from");
        await call(
            "games_player_access",
            { serverId: GAME, action: "grant", username: "Steve", address: "any" },
            ["gameservers.manage"]
        );
        expect(mocks.gameServerAccess).toHaveBeenCalledWith(ADA, GAME, "games.manage");
        expect(mocks.grantPlayerAccess).toHaveBeenCalledWith("owner-1", GAME, "user-1", {
            username: "Steve",
            address: "any"
        });
        audited("minecraft.access-grant");
        await call("games_player_access", { serverId: GAME, action: "revoke", username: "Steve" }, [
            "gameservers.manage"
        ]);
        expect(mocks.revokePlayerAccess).toHaveBeenCalledWith("owner-1", GAME, "Steve");
        audited("minecraft.access-revoke");
    });

    it("reads the list as the person may see it, and the roster only from a server that answers", async () => {
        const view = {
            rules: [],
            refusals: [],
            links: [],
            bindAddresses: true,
            addressesAvailable: true,
            edition: "java"
        };
        mocks.listPlayerAccess.mockResolvedValue(view);
        mocks.forViewer.mockResolvedValue(view);
        mocks.listGameServerPresence.mockResolvedValue([
            { id: GAME, answering: false, players: [], online: 0, max: 20 }
        ]);
        const read = await call("games_players", { serverId: GAME }, ["gameservers.read"]);
        expect(mocks.forViewer).toHaveBeenCalledWith(view, ADA);
        expect(mocks.getServerRoster).not.toHaveBeenCalled();
        expect(read.structuredContent).toMatchObject({ online: [], roster: null });
    });
});

describe("announcements", () => {
    it("send on the console standing, a template or words written here, and are recorded", async () => {
        mocks.listTemplates.mockResolvedValue([
            {
                id: "tpl-1",
                name: "Restart soon",
                announcement: { target: "@a", title: "Restart", chat: "", hold: "timed" }
            }
        ]);
        const sent = await call("games_announce", { serverId: GAME, templateId: "tpl-1" }, [
            "gameservers.manage"
        ]);
        expect(mocks.gameServerAccess).toHaveBeenCalledWith(ADA, GAME, "games.console");
        expect(mocks.announceNow).toHaveBeenCalledWith(
            "owner-1",
            GAME,
            expect.objectContaining({ title: "Restart" }),
            "user-1"
        );
        expect(sent.structuredContent).toMatchObject({ sent: 3 });
        audited("games.announce");

        const both = await call(
            "games_announce",
            { serverId: GAME, templateId: "tpl-1", announcement: { target: "@a", chat: "Hi" } },
            ["gameservers.manage"]
        );
        expect(both.isError).toBe(true);
    });

    it("delete only a template the server keeps, and record nothing for one it does not", async () => {
        mocks.listTemplates.mockResolvedValue([
            {
                id: "tpl-1",
                name: "Restart soon",
                announcement: { target: "@a", title: "Restart", chat: "", hold: "timed" }
            }
        ]);
        const missing = await call(
            "games_announcement_template_delete",
            { serverId: GAME, templateId: "tpl-404" },
            ["gameservers.manage"]
        );
        expect(missing.isError).toBeFalsy();
        expect(missing.structuredContent).toMatchObject({ deleted: false });
        expect(mocks.deleteTemplate).not.toHaveBeenCalled();
        expect(mocks.recordAudit).not.toHaveBeenCalled();

        const deleted = await call(
            "games_announcement_template_delete",
            { serverId: GAME, templateId: "tpl-1" },
            ["gameservers.manage"]
        );
        expect(deleted.structuredContent).toMatchObject({ deleted: true });
        expect(mocks.deleteTemplate).toHaveBeenCalledWith(GAME, "tpl-1");
        audited("games.announce.template-delete");
    });

    it("are Minecraft's only", async () => {
        mocks.gameServerAccess.mockResolvedValue(standing("ark"));
        const refused = await call(
            "games_announce",
            { serverId: GAME, announcement: { target: "@a", chat: "Hi" } },
            ["gameservers.manage"]
        );
        expect(refused.isError).toBe(true);
        expect(mocks.announceNow).not.toHaveBeenCalled();
    });
});

describe("restarts", () => {
    it("are booked and called off on the managing standing, and an empty cancel records nothing", async () => {
        await call(
            "games_restart_schedule",
            { serverId: GAME, when: "empty", reason: "New mods" },
            ["gameservers.manage"]
        );
        expect(mocks.requestRestart).toHaveBeenCalledWith(GAME, {
            when: "empty",
            at: null,
            reason: "New mods",
            requestedBy: "user-1"
        });
        audited("games.restart.book");

        mocks.readRestartRequest.mockResolvedValue(null);
        const nothing = await call("games_restart_cancel", { serverId: GAME }, [
            "gameservers.manage"
        ]);
        expect(nothing.structuredContent).toMatchObject({ cancelled: false });
        expect(mocks.cancelRestart).not.toHaveBeenCalled();

        mocks.readRestartRequest.mockResolvedValue({
            when: "empty",
            at: null,
            reason: "",
            requestedAt: "",
            requestedBy: ""
        });
        await call("games_restart_cancel", { serverId: GAME }, ["gameservers.manage"]);
        expect(mocks.cancelRestart).toHaveBeenCalledWith(GAME);
        audited("games.restart.cancel");
    });
});

describe("worlds and backups", () => {
    it("restore only when the call says the person said yes, and is marked destructive", async () => {
        const restore = TOOLS.find((tool) => tool.name === "games_backup_restore")!;
        expect(restore.destructive).toBe(true);
        expect(restore.description).toMatch(/^DESTRUCTIVE/);

        const unconfirmed = await call("games_backup_restore", { serverId: GAME, name: BACKUP }, [
            "gameservers.manage"
        ]);
        expect(unconfirmed.isError).toBe(true);
        expect(mocks.restoreWorldBackup).not.toHaveBeenCalled();

        const restored = await call(
            "games_backup_restore",
            { serverId: GAME, name: BACKUP, confirm: true },
            ["gameservers.manage"]
        );
        expect(mocks.gameServerAccess).toHaveBeenCalledWith(ADA, GAME, "games.manage");
        expect(mocks.restoreWorldBackup).toHaveBeenCalledWith("owner-1", GAME, BACKUP, "user-1");
        expect(restored.structuredContent).toMatchObject({ level: "world-restored" });
        audited("games.world-restore");
    });

    it("back up on the managing standing, and refuse a name that is not a backup's", async () => {
        await call("games_backup", { serverId: GAME }, ["gameservers.manage"]);
        expect(mocks.createWorldBackup).toHaveBeenCalledWith("owner-1", GAME);
        audited("games.world-backup");
        const bad = await call(
            "games_backup_restore",
            { serverId: GAME, name: "../../etc/passwd", confirm: true },
            ["gameservers.manage"]
        );
        expect(bad.isError).toBe(true);
        expect(mocks.restoreWorldBackup).not.toHaveBeenCalled();
    });
});

describe("players in polaris_search", () => {
    it("are the ones the servers this account sees have had, each pointing at what acts on them", async () => {
        mocks.reachableInstallIds.mockResolvedValue([GAME]);
        mocks.listGameServerFacts.mockResolvedValue([
            { id: GAME, name: "Survival", catalogName: "Minecraft", game: "minecraft" }
        ]);
        mocks.searchKnownPlayers.mockResolvedValue([
            {
                installedAppId: GAME,
                name: "Steve",
                playerId: null,
                lastSeen: "2026-10-06T10:00:00.000Z",
                online: true
            }
        ]);
        const providers = await gameServersExtension.mcpSearch!();
        const players = providers.find((provider) => provider.id === "game-servers.players")!;
        expect(players.scope).toBe("gameservers.read");
        const hits = await players.search("stev", { userId: "user-1" } as never, 10);
        expect(mocks.searchKnownPlayers).toHaveBeenCalledWith([GAME], "stev", 10);
        expect(hits[0]).toMatchObject({ name: "Steve", kind: "player", where: "Survival" });
        expect(hits[0]!.next.map((step) => step.tool)).toEqual([
            "games_players",
            "games_player_moderate",
            "games_player_timeout"
        ]);
        expect(hits[0]!.next[1]!.args).toEqual({ serverId: GAME, player: "Steve" });
    });

    it("point a game the moderation tools do not reach only at the player list", async () => {
        mocks.reachableInstallIds.mockResolvedValue([GAME]);
        mocks.listGameServerFacts.mockResolvedValue([
            { id: GAME, name: "City", catalogName: "FiveM", game: "fivem" }
        ]);
        mocks.searchKnownPlayers.mockResolvedValue([
            {
                installedAppId: GAME,
                name: "Niko",
                playerId: "license:0000000000000000000000000000000000000000",
                lastSeen: "2026-10-06T10:00:00.000Z",
                online: false
            }
        ]);
        const providers = await gameServersExtension.mcpSearch!();
        const players = providers.find((provider) => provider.id === "game-servers.players")!;
        const hits = await players.search("niko", { userId: "user-1" } as never, 10);
        expect(hits[0]!.next.map((step) => step.tool)).toEqual(["games_players"]);
    });
});
