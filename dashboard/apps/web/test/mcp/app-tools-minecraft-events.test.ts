/**
 * Game servers' Minecraft event tools, called the way an MCP client calls them.
 *
 * What is pinned is that they are the Events screen's own buttons: every one
 * asks for the console grant on that server, as the screen's actions do; an
 * event is started from one the server has set up, through the same service
 * call with the same "manual" trigger (so its preconditions - nobody on,
 * another event on, Bedrock, peaceful - refuse exactly as on the screen), and
 * is written to the audit the same way. The kinds come from the catalog.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    actingUser: vi.fn(),
    recordAudit: vi.fn(),
    gameServerAccess: vi.fn(),
    reachableInstallIds: vi.fn(),
    eventsView: vi.fn(),
    startEvent: vi.fn(),
    cancelEvent: vi.fn()
}));

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/mcp/acting-user", () => ({ actingUser: mocks.actingUser }));
vi.mock("@/lib/session", () => ({ sessionCan: vi.fn() }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: mocks.recordAudit }));
vi.mock("@/lib/i18n/request", () => ({ getLocale: async () => "en-US" }));
vi.mock("@/lib/apps/install-access", () => ({
    gameServerAccess: mocks.gameServerAccess,
    reachableInstallIds: mocks.reachableInstallIds
}));
vi.mock("@polaris-app/game-servers/src/lib/games-service", () => ({
    listGameServerFacts: vi.fn(),
    listGameServerPresence: vi.fn(),
    withNamesOnly: vi.fn()
}));
vi.mock("@polaris-app/game-servers/src/lib/games-operations", () => ({
    setServerRunning: vi.fn(),
    restartServerNow: vi.fn(),
    runConsoleCommand: vi.fn()
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/events/events-service", () => ({
    eventsView: mocks.eventsView,
    startEvent: mocks.startEvent,
    cancelEvent: mocks.cancelEvent
}));

const { gameServersExtension } = await import("@polaris-app/game-servers/src/lib/games-extension");
const { gameMessage } = await import("@polaris-app/game-servers/src/lib/game-message");
const catalog = await import("@polaris-app/game-servers/src/lib/minecraft/events/catalog");
const { handleMcpMessage } = await import("@/lib/mcp/protocol");

const TOOLS = await gameServersExtension.mcpTools!();
const SERVER = { name: "polaris", version: "1", instructions: "" };
const ADA = { id: "user-1", email: "ada@example.test", name: "Ada", isAdmin: false, sessionId: "" };
const GAME = "33333333-3333-4333-8333-333333333333";
const STANDING = {
    ownerId: "owner-1",
    isOwner: false,
    install: {
        id: GAME,
        name: "Survival",
        catalogId: "minecraft-java",
        applicationId: "app-1",
        status: "running"
    }
};

type ToolResult = { content: { text: string }[]; isError?: boolean; structuredContent?: any };

async function call(name: string, args: Record<string, unknown>, scopes: string[]) {
    const reply = await handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        TOOLS,
        { userId: "user-1", isAdmin: false, scopes: scopes as never, grantId: "grant-1" },
        SERVER
    );
    if (reply?.error) return { content: [{ text: reply.error.message }], isError: true };
    return reply?.result as ToolResult;
}

const MINING = { ...catalog.newPreset("mining-rush", "mine-1", "Diamond dash"), enabled: true };
const MOON = { ...catalog.newPreset("blood-moon", "moon-1", "Blood moon"), enabled: false };

function view(extra: Record<string, unknown> = {}) {
    return {
        config: { presets: [MINING, MOON], settings: {} },
        run: null,
        history: [
            {
                id: "h1",
                presetId: "mine-1",
                kind: "mining-rush",
                name: "Diamond dash",
                trigger: "manual",
                outcome: "finished",
                note: "Won by Steve.",
                startedAt: 1_700_000_000_000,
                endedAt: 1_700_000_600_000,
                participants: 3,
                podium: [{ place: 1, name: "Steve", score: 42 }],
                disqualified: [],
                delivered: [],
                search: null,
                keptOut: []
            }
        ],
        pending: [],
        stashFailures: [],
        nextRandomAt: null,
        waiting: null,
        drawCheckedAt: null,
        lastRandom: null,
        players: { online: 3, active: 2 },
        refusal: null,
        version: "1.21.1",
        repaired: [],
        ...extra
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.actingUser.mockResolvedValue(ADA);
    mocks.gameServerAccess.mockResolvedValue(STANDING);
    mocks.eventsView.mockResolvedValue(view());
    mocks.startEvent.mockResolvedValue({ preset: MINING, startsAt: 1, endsAt: 2 });
});

describe("games_event_kinds", () => {
    it("lists every kind in the catalog with what it can be set to", async () => {
        const result = await call("games_event_kinds", {}, ["gameservers.read"]);
        const kinds = result.structuredContent.kinds as {
            kind: string;
            options: Record<string, unknown>;
            defaults: Record<string, unknown>;
        }[];
        expect(kinds.map((entry) => entry.kind)).toEqual([...catalog.OFFERED_KINDS]);
        const mining = kinds.find((entry) => entry.kind === "mining-rush")!;
        expect(mining).toMatchObject({
            name: "Mining rush",
            competitive: true,
            minutes: catalog.DEFAULT_MINUTES["mining-rush"],
            defaults: { target: "any-ore" },
            options: { target: { oneOf: ["any-ore", "diamond", "debris"] } }
        });
        expect(result.content[0]?.text).toContain("mining-rush");
    });

    it("narrows by a few words", async () => {
        const result = await call("games_event_kinds", { query: "boss" }, ["gameservers.read"]);
        const names = (result.structuredContent.kinds as { kind: string }[]).map(
            (entry) => entry.kind
        );
        expect(names).toContain("world-boss");
        expect(names).not.toContain("mining-rush");
    });
});

describe("games_events", () => {
    it("reads a server's events with the console grant, as the Events screen does", async () => {
        const result = await call("games_events", { serverId: GAME }, ["gameservers.read"]);
        expect(mocks.gameServerAccess).toHaveBeenCalledWith(ADA, GAME, "games.console");
        expect(mocks.eventsView).toHaveBeenCalledWith(GAME);
        expect(result.structuredContent).toMatchObject({
            serverId: GAME,
            events: [
                { id: "mine-1", name: "Diamond dash", kind: "mining-rush", enabled: true },
                { id: "moon-1", name: "Blood moon", kind: "blood-moon", enabled: false }
            ],
            running: null,
            recent: [
                {
                    name: "Diamond dash",
                    outcome: "finished",
                    podium: [{ place: 1, name: "Steve", score: 42 }]
                }
            ],
            players: { online: 3, active: 2 }
        });
    });

    it("shows the event on now with its standings", async () => {
        mocks.eventsView.mockResolvedValue(
            view({
                run: {
                    presetId: "mine-1",
                    name: "Diamond dash",
                    kind: "mining-rush",
                    phase: "running",
                    startsAt: 1_700_000_000_000,
                    endsAt: 1_700_000_600_000,
                    trigger: "manual",
                    cancelling: false,
                    standings: [{ name: "Alex", score: 7 }]
                }
            })
        );
        const result = await call("games_events", { serverId: GAME }, ["gameservers.read"]);
        expect(result.structuredContent.running).toMatchObject({
            name: "Diamond dash",
            phase: "running",
            standings: [{ name: "Alex", score: 7 }]
        });
        expect(result.content[0]?.text).toContain("Alex 7");
    });

    it("refuses a server the person has no console on", async () => {
        mocks.gameServerAccess.mockResolvedValue(null);
        const result = await call("games_events", { serverId: GAME }, ["gameservers.read"]);
        expect(result.isError).toBe(true);
        expect(mocks.eventsView).not.toHaveBeenCalled();
    });
});

describe("games_event_start", () => {
    it("needs the managing scope: reading does not start anything", async () => {
        const result = await call("games_event_start", { serverId: GAME, eventId: "mine-1" }, [
            "gameservers.read"
        ]);
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("gameservers.manage");
        expect(mocks.startEvent).not.toHaveBeenCalled();
    });

    it("starts one the server set up, through the screen's own call, and audits it the same way", async () => {
        const result = await call("games_event_start", { serverId: GAME, eventId: "mine-1" }, [
            "gameservers.manage"
        ]);
        expect(mocks.gameServerAccess).toHaveBeenCalledWith(ADA, GAME, "games.console");
        expect(mocks.startEvent).toHaveBeenCalledWith({
            ownerId: "owner-1",
            installedAppId: GAME,
            presetId: "mine-1",
            trigger: "manual",
            startedBy: "user-1"
        });
        expect(mocks.recordAudit).toHaveBeenCalledWith({
            actorId: "user-1",
            action: "games.events.start",
            targetType: "installedApp",
            targetId: GAME,
            metadata: { event: "Diamond dash", kind: "mining-rush", via: "mcp" }
        });
        expect(result.content[0]?.text).toContain("Diamond dash");
    });

    it("passes on the screen's own refusal, in words", async () => {
        mocks.startEvent.mockRejectedValue(
            new Error(gameMessage("minecraft", "events.errors.nobodyOn"))
        );
        const result = await call("games_event_start", { serverId: GAME, eventId: "mine-1" }, [
            "gameservers.manage"
        ]);
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).not.toContain("minecraft:");
        expect(result.content[0]?.text.length).toBeGreaterThan(5);
        expect(mocks.recordAudit).not.toHaveBeenCalled();
    });

    it("refuses an id that is not an event's before asking the server", async () => {
        const result = await call("games_event_start", { serverId: GAME, eventId: "" }, [
            "gameservers.manage"
        ]);
        expect(result.isError).toBe(true);
        expect(mocks.gameServerAccess).not.toHaveBeenCalled();
    });
});

describe("games_event_cancel", () => {
    it("calls off the event on now through the screen's own call", async () => {
        const result = await call("games_event_cancel", { serverId: GAME }, ["gameservers.manage"]);
        expect(mocks.cancelEvent).toHaveBeenCalledWith("owner-1", GAME);
        expect(mocks.recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: "games.events.cancel", targetId: GAME })
        );
        expect(result.isError).toBeUndefined();
    });

    it("says so when nothing is on", async () => {
        mocks.cancelEvent.mockRejectedValue(
            new Error(gameMessage("minecraft", "events.errors.noneOn"))
        );
        const result = await call("games_event_cancel", { serverId: GAME }, ["gameservers.manage"]);
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).not.toContain("minecraft:");
    });
});

describe("the event tools' annotations", () => {
    it("marks the reads read-only and the rest as changing something", () => {
        const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
        expect(byName.get("games_event_kinds")?.readOnly).toBe(true);
        expect(byName.get("games_events")?.readOnly).toBe(true);
        expect(byName.get("games_event_start")?.readOnly).toBe(false);
        expect(byName.get("games_event_cancel")?.readOnly).toBe(false);
        expect(byName.get("games_event_start")?.scope).toBe("gameservers.manage");
    });
});
