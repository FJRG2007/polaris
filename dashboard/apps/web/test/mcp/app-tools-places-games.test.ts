/**
 * Places' and Game servers' MCP tools, called the way an MCP client calls them.
 *
 * What is pinned is the boundary with each app's own rules. Seeing devices does
 * not open operating them; a device is operated through the device panel's own
 * path, with the setting in the shape its kind takes; routines need what the
 * routines screen needs. A game server is reached through the same standing
 * its pages read - the console through the console grant on that server - and
 * stopped through the same function as its Stop button.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    actingUser: vi.fn(),
    sessionCan: vi.fn(),
    recordAudit: vi.fn(),
    homeInstall: vi.fn(),
    listDevices: vi.fn(),
    getDevice: vi.fn(),
    listPlaces: vi.fn(),
    placesReach: vi.fn(),
    operateDevice: vi.fn(),
    listAutomations: vi.fn(),
    runAutomationNow: vi.fn(),
    gameServerAccess: vi.fn(),
    reachableInstallIds: vi.fn(),
    listGameServerFacts: vi.fn(),
    listGameServerPresence: vi.fn(),
    setServerRunning: vi.fn(),
    restartServerNow: vi.fn(),
    runConsoleCommand: vi.fn(),
    readPlayerInventory: vi.fn(),
    givePlayerItems: vi.fn(),
    takePlayerItems: vi.fn(),
    emptyPlayerInventory: vi.fn(),
    sendPlayerInventory: vi.fn()
}));

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/mcp/acting-user", () => ({ actingUser: mocks.actingUser }));
vi.mock("@/lib/session", () => ({ sessionCan: mocks.sessionCan }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: mocks.recordAudit }));
vi.mock("@/lib/i18n/request", () => ({ getLocale: async () => "en-US" }));
vi.mock("@/lib/apps/install-access", () => ({
    gameServerAccess: mocks.gameServerAccess,
    reachableInstallIds: mocks.reachableInstallIds
}));
vi.mock("@polaris-app/places/src/lib/access", () => ({ homeInstall: mocks.homeInstall }));
vi.mock("@polaris-app/places/src/lib/devices", () => ({
    listDevices: mocks.listDevices,
    getDevice: mocks.getDevice
}));
vi.mock("@polaris-app/places/src/lib/places", () => ({ listPlaces: mocks.listPlaces }));
vi.mock("@polaris-app/places/src/lib/sharing", () => ({
    placesReach: mocks.placesReach,
    onlyReachable: <T extends { id: string }>(
        things: T[],
        allowed: true | ReadonlyMap<string, unknown>
    ) => (allowed === true ? things : things.filter((thing) => allowed.has(thing.id)))
}));
vi.mock("@polaris-app/places/src/lib/device-operation", () => ({
    operateDevice: mocks.operateDevice
}));
vi.mock("@polaris-app/places/src/lib/automations", () => ({
    listAutomations: mocks.listAutomations,
    runAutomationNow: mocks.runAutomationNow
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
    setServerRunning: mocks.setServerRunning,
    restartServerNow: mocks.restartServerNow,
    runConsoleCommand: mocks.runConsoleCommand
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/inventory-service", () => ({
    readPlayerInventory: mocks.readPlayerInventory
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/item-operations", () => ({
    givePlayerItems: mocks.givePlayerItems,
    takePlayerItems: mocks.takePlayerItems,
    emptyPlayerInventory: mocks.emptyPlayerInventory,
    sendPlayerInventory: mocks.sendPlayerInventory
}));

const { placesExtension } = await import("@polaris-app/places/src/lib/places-extension");
const { gameServersExtension } = await import("@polaris-app/game-servers/src/lib/games-extension");
const { gameMessage } = await import("@polaris-app/game-servers/src/lib/game-message");
const { handleMcpMessage } = await import("@/lib/mcp/protocol");

const TOOLS = [...(await placesExtension.mcpTools!()), ...(await gameServersExtension.mcpTools!())];
const SERVER = { name: "polaris", version: "1", instructions: "" };
const ADA = { id: "user-1", email: "ada@example.test", name: "Ada", isAdmin: false, sessionId: "" };
const INSTALL = { id: "install-1", ownerId: "owner-1", name: "Home" };
const DEVICE = "11111111-1111-4111-8111-111111111111";
const ROUTINE = "22222222-2222-4222-8222-222222222222";
const GAME = "33333333-3333-4333-8333-333333333333";

type ToolResult = { content: { text: string }[]; isError?: boolean; structuredContent?: any };

async function call(name: string, args: Record<string, unknown>, scopes: string[]) {
    const reply = await handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        TOOLS,
        { userId: "user-1", isAdmin: false, scopes: scopes as never, grantId: "grant-1" },
        SERVER
    );
    return reply?.result as ToolResult;
}

function device(kind: string, extra: Record<string, unknown> = {}) {
    return {
        id: DEVICE,
        vendor: "acme",
        kind,
        name: "Front door",
        zone: "Hall",
        placeId: "place-1",
        model: "",
        firmware: "",
        state: "locked",
        doorState: "closed",
        batteryPercent: 80,
        batteryCritical: false,
        online: true,
        controllable: true,
        reading: null,
        stateAt: null,
        ...extra
    };
}

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

beforeEach(() => {
    vi.clearAllMocks();
    mocks.actingUser.mockResolvedValue(ADA);
    mocks.homeInstall.mockResolvedValue(INSTALL);
    mocks.listPlaces.mockResolvedValue([{ id: "place-1", name: "Flat" }]);
    mocks.placesReach.mockResolvedValue({ everything: true });
    mocks.sessionCan.mockResolvedValue(true);
    mocks.operateDevice.mockImplementation(async () => device("lock", { state: "unlocked" }));
    mocks.gameServerAccess.mockResolvedValue(STANDING);
});

describe("the Places tools", () => {
    it("list devices with their state to the read scope, and nothing more", async () => {
        mocks.listDevices.mockResolvedValue([device("lock")]);
        const result = await call("places_devices", {}, ["places.read"]);
        expect(mocks.listDevices).toHaveBeenCalledWith(INSTALL.id);
        expect(result.structuredContent.devices[0]).toMatchObject({
            id: DEVICE,
            place: "Flat",
            state: "locked",
            actions: ["lock", "unlock", "open"]
        });
        const control = await call(
            "places_device_control",
            { deviceId: DEVICE, action: "unlock" },
            ["places.read"]
        );
        expect(control.isError).toBe(true);
        expect(control.content[0]?.text).toContain("places.control");
        expect(mocks.operateDevice).not.toHaveBeenCalled();
    });

    it("find a device by what it is, in another language, best match first", async () => {
        // The report: "door" against a lock called "Puerta principal" answered
        // "No devices.", and the assistant told its person there was no door.
        mocks.listDevices.mockResolvedValue([
            device("light", { id: "44444444-4444-4444-8444-444444444444", name: "Lámpara" }),
            device("lock", { name: "Puerta principal", zone: "Entrada" })
        ]);
        const door = await call("places_devices", { query: "door" }, ["places.read"]);
        expect(door.structuredContent.devices[0]).toMatchObject({ name: "Puerta principal" });
        expect(door.structuredContent.matched).toBe(true);
        expect(door.content[0]?.text).not.toContain("No devices");

        const typo = await call("places_devices", { query: "puerat" }, ["places.read"]);
        expect(typo.structuredContent.devices[0]).toMatchObject({ name: "Puerta principal" });
    });

    it("answer every device it may see, said as such, when nothing matches", async () => {
        mocks.listDevices.mockResolvedValue([device("lock", { name: "Puerta principal" })]);
        const result = await call("places_devices", { query: "zebra" }, ["places.read"]);
        expect(result.structuredContent.devices).toHaveLength(1);
        expect(result.structuredContent.matched).toBe(false);
        expect(result.content[0]?.text).toContain('No match for "zebra"; these are all 1 device.');
    });

    it("still answer nothing past what the person may see", async () => {
        mocks.placesReach.mockResolvedValue({ everything: false, devices: new Map() });
        mocks.listDevices.mockResolvedValue([device("lock", { name: "Puerta principal" })]);
        const result = await call("places_devices", { query: "zebra" }, ["places.read"]);
        expect(result.structuredContent.devices).toEqual([]);
        expect(result.content[0]?.text).toBe("No devices.");
    });

    it("operate a device through the panel's own path, as the person", async () => {
        const result = await call("places_device_control", { deviceId: DEVICE, action: "unlock" }, [
            "places.control"
        ]);
        expect(result.isError).toBeUndefined();
        expect(mocks.operateDevice).toHaveBeenCalledWith(
            ADA,
            INSTALL.id,
            DEVICE,
            "unlock",
            undefined
        );
    });

    it("open a door with the screen's own word, which is not unlocking it", async () => {
        // The report: asked to open the door, the assistant unlocked it - twice -
        // because the button that says Open was offered as "unlatch".
        const opened = await call("places_device_control", { deviceId: DEVICE, action: "open" }, [
            "places.control"
        ]);
        expect(opened.isError).toBeUndefined();
        expect(mocks.operateDevice).toHaveBeenLastCalledWith(
            ADA,
            INSTALL.id,
            DEVICE,
            "unlatch",
            undefined
        );
        const tool = TOOLS.find((one) => one.name === "places_device_control")!;
        expect(tool.description).toMatch(/open/i);
        // A client that learned the old word still reaches the same button.
        await call("places_device_control", { deviceId: DEVICE, action: "unlatch" }, [
            "places.control"
        ]);
        expect(mocks.operateDevice).toHaveBeenLastCalledWith(
            ADA,
            INSTALL.id,
            DEVICE,
            "unlatch",
            undefined
        );
    });

    it("send a fan speed in the shape each kind takes, and refuse a setting without a value", async () => {
        mocks.getDevice.mockResolvedValue(device("air"));
        await call("places_device_control", { deviceId: DEVICE, action: "set-fan", fan: "low" }, [
            "places.control"
        ]);
        expect(mocks.operateDevice.mock.calls[0]![4]).toEqual({ action: "set-fan", speed: "low" });

        mocks.getDevice.mockResolvedValue(device("climate"));
        await call("places_device_control", { deviceId: DEVICE, action: "set-fan", fan: "low" }, [
            "places.control"
        ]);
        expect(mocks.operateDevice.mock.calls[1]![4]).toEqual({ action: "set-fan", fan: "low" });

        const missing = await call(
            "places_device_control",
            { deviceId: DEVICE, action: "set-temperature" },
            ["places.control"]
        );
        expect(missing.isError).toBe(true);
        expect(mocks.operateDevice).toHaveBeenCalledTimes(2);
    });

    it("pass Places' own refusal on as written", async () => {
        const { HomeError } = await import("@polaris-app/places/src/lib/home-error");
        mocks.operateDevice.mockRejectedValue(
            new HomeError("Front door was not answering when it was last checked")
        );
        const result = await call("places_device_control", { deviceId: DEVICE, action: "lock" }, [
            "places.control"
        ]);
        expect(result.content[0]?.text).toBe(
            "Front door was not answering when it was last checked"
        );
    });

    it("run a routine only for somebody who manages the house, and record it", async () => {
        mocks.sessionCan.mockResolvedValue(false);
        const refused = await call("places_routine_run", { routineId: ROUTINE }, [
            "places.routines"
        ]);
        expect(refused.content[0]?.text).toContain("manages the house");
        expect(mocks.sessionCan).toHaveBeenCalledWith(ADA, "home.manage");
        expect(mocks.runAutomationNow).not.toHaveBeenCalled();

        mocks.sessionCan.mockResolvedValue(true);
        const ran = await call("places_routine_run", { routineId: ROUTINE }, ["places.routines"]);
        expect(ran.isError).toBeUndefined();
        expect(mocks.runAutomationNow).toHaveBeenCalledWith(
            INSTALL.id,
            ROUTINE,
            "Ada",
            expect.any(String)
        );
        expect(mocks.recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                actorId: "user-1",
                action: "places.automation.run",
                targetId: ROUTINE
            })
        );
        expect(
            (await call("places_routine_run", { routineId: ROUTINE }, ["places.control"])).isError
        ).toBe(true);
    });
});

describe("the Game servers tools", () => {
    it("read one server's status through the same standing its page reads", async () => {
        mocks.listGameServerFacts.mockResolvedValue([
            { id: GAME, running: true, address: "play.example.test", slots: 20 }
        ]);
        mocks.listGameServerPresence.mockResolvedValue([
            {
                id: GAME,
                answering: true,
                containerRunning: true,
                online: 1,
                max: 20,
                players: [{ name: "Steve", id: null }],
                message: null
            }
        ]);
        const result = await call("games_server_status", { serverId: GAME }, ["gameservers.read"]);
        expect(mocks.gameServerAccess).toHaveBeenCalledWith(ADA, GAME, "games.read");
        expect(mocks.listGameServerFacts).toHaveBeenCalledWith("owner-1", [], [GAME]);
        expect(result.structuredContent).toMatchObject({
            status: "online",
            online: 1,
            players: ["Steve"]
        });
    });

    it("refuse a server the person cannot see, and the managing tools to the read scope", async () => {
        mocks.gameServerAccess.mockResolvedValue(null);
        const unseen = await call("games_server_status", { serverId: GAME }, ["gameservers.read"]);
        expect(unseen.content[0]?.text).toContain("no game server with that id");
        const power = await call("games_server_power", { serverId: GAME, action: "stop" }, [
            "gameservers.read"
        ]);
        expect(power.content[0]?.text).toContain("gameservers.manage");
        expect(mocks.setServerRunning).not.toHaveBeenCalled();
    });

    it("read a Minecraft player's inventory to the read scope, live or as the copy kept", async () => {
        const minecraft = { ...STANDING, install: { ...STANDING.install, catalogId: "minecraft" } };
        mocks.gameServerAccess.mockResolvedValue(minecraft);
        mocks.readPlayerInventory.mockResolvedValue({
            inventory: {
                items: [
                    {
                        slot: 0,
                        id: "minecraft:bow",
                        count: 1,
                        data: {
                            era: "components",
                            snbt: '{"minecraft:enchantments": {levels: {"minecraft:power": 5}}}'
                        }
                    },
                    { slot: 9, id: "minecraft:diamond", count: 12, data: null }
                ],
                live: true,
                takenAt: "2026-10-06T20:00:00.000Z"
            }
        });
        const result = await call("games_player_inventory", { serverId: GAME, player: "Steve" }, [
            "gameservers.read"
        ]);
        expect(mocks.gameServerAccess).toHaveBeenCalledWith(ADA, GAME, "games.read");
        expect(mocks.readPlayerInventory).toHaveBeenCalledWith("owner-1", GAME, "Steve");
        expect(result.isError).toBeFalsy();
        expect(result.content[0]?.text).toContain("minecraft:bow x1");
        expect(result.content[0]?.text).toContain("minecraft:power");
        expect(result.structuredContent).toMatchObject({
            live: true,
            items: [
                { slot: 0, id: "minecraft:bow", count: 1 },
                { slot: 9, id: "minecraft:diamond", count: 12, components: null }
            ]
        });

        mocks.readPlayerInventory.mockResolvedValue({
            inventory: { items: [], live: false, takenAt: "2026-10-06T19:00:00.000Z" }
        });
        const kept = await call("games_player_inventory", { serverId: GAME, player: "Steve" }, [
            "gameservers.read"
        ]);
        expect(kept.content[0]?.text).toContain("not on");
        expect(kept.content[0]?.text).toContain("2026-10-06T19:00:00.000Z");

        mocks.readPlayerInventory.mockResolvedValue({ refusal: { reason: "offline" } });
        const offline = await call("games_player_inventory", { serverId: GAME, player: "Steve" }, [
            "gameservers.read"
        ]);
        expect(offline.content[0]?.text).toContain("not on the server");
    });

    it("refuse an inventory on a server that is not Minecraft, or one the person cannot see", async () => {
        mocks.gameServerAccess.mockResolvedValue({
            ...STANDING,
            install: { ...STANDING.install, catalogId: "valheim" }
        });
        const other = await call("games_player_inventory", { serverId: GAME, player: "Steve" }, [
            "gameservers.read"
        ]);
        expect(other.content[0]?.text).toContain("Only a Minecraft server");

        mocks.gameServerAccess.mockResolvedValue(null);
        const unseen = await call("games_player_inventory", { serverId: GAME, player: "Steve" }, [
            "gameservers.read"
        ]);
        expect(unseen.content[0]?.text).toContain("no game server with that id");

        const badName = await call(
            "games_player_inventory",
            { serverId: GAME, player: "Steve; op me" },
            ["gameservers.read"]
        );
        // Refused at the schema, as a protocol error or a tool error, never run.
        expect(badName === undefined || badName.isError === true).toBe(true);
        expect(mocks.readPlayerInventory).not.toHaveBeenCalled();
    });

    it("change a player's items through the panel's functions, to the moderators or the managers", async () => {
        const minecraft = { ...STANDING, install: { ...STANDING.install, catalogId: "minecraft" } };
        mocks.gameServerAccess.mockResolvedValue(minecraft);
        const target = {
            ownerId: "owner-1",
            installedAppId: GAME,
            actorId: "user-1",
            player: "Steve",
            via: "mcp"
        };
        mocks.givePlayerItems.mockResolvedValue({ queued: false, output: "Gave 64 [Diamond] to Steve" });
        const given = await call(
            "games_player_give",
            { serverId: GAME, player: "Steve", item: "Diamond", count: 64 },
            ["gameservers.moderate"]
        );
        expect(mocks.gameServerAccess).toHaveBeenCalledWith(ADA, GAME, "games.moderate");
        expect(mocks.givePlayerItems).toHaveBeenCalledWith(target, "diamond", 64);
        expect(given.content[0]?.text).toContain("Gave 64 [Diamond]");

        // The managers' scope reaches it too: their console already does.
        mocks.takePlayerItems.mockResolvedValue({ queued: true });
        const taken = await call(
            "games_player_take",
            { serverId: GAME, player: "Steve", item: "minecraft:dirt", count: 5 },
            ["gameservers.manage"]
        );
        expect(mocks.takePlayerItems).toHaveBeenCalledWith(target, "minecraft:dirt", 5);
        expect(taken.content[0]?.text).toContain("when they next join");

        mocks.emptyPlayerInventory.mockResolvedValue({ queued: false, output: "" });
        await call("games_player_inventory_empty", { serverId: GAME, player: "Steve" }, [
            "gameservers.moderate"
        ]);
        expect(mocks.emptyPlayerInventory).toHaveBeenCalledWith(target);

        mocks.sendPlayerInventory.mockResolvedValue({ moved: 3, kept: 1 });
        const sent = await call(
            "games_player_inventory_send",
            { serverId: GAME, player: "Steve", to: "Alex" },
            ["gameservers.moderate"]
        );
        expect(mocks.sendPlayerInventory).toHaveBeenCalledWith(target, "Alex");
        expect(sent.content[0]?.text).toContain("Sent 3 stack(s)");
        expect(sent.content[0]?.text).toContain("1 stayed with Steve");
    });

    it("refuse item changes to the read scope, off Minecraft, without the grant, or to oneself", async () => {
        const read = await call(
            "games_player_give",
            { serverId: GAME, player: "Steve", item: "diamond", count: 1 },
            ["gameservers.read"]
        );
        expect(read.content[0]?.text).toContain("gameservers.moderate");

        mocks.gameServerAccess.mockResolvedValue({
            ...STANDING,
            install: { ...STANDING.install, catalogId: "valheim" }
        });
        const other = await call("games_player_inventory_empty", { serverId: GAME, player: "Steve" }, [
            "gameservers.moderate"
        ]);
        expect(other.content[0]?.text).toContain("not something Polaris can do");

        mocks.gameServerAccess.mockResolvedValue(null);
        const refused = await call(
            "games_player_take",
            { serverId: GAME, player: "Steve", item: "diamond", count: 1 },
            ["gameservers.moderate"]
        );
        expect(refused.content[0]?.text).toContain("cannot do that");

        const self = await call(
            "games_player_inventory_send",
            { serverId: GAME, player: "Steve", to: "steve" },
            ["gameservers.moderate"]
        );
        expect(self.content[0]?.text).toContain("same player");

        const badItem = await call(
            "games_player_give",
            { serverId: GAME, player: "Steve", item: "diamond 64 {x}", count: 1 },
            ["gameservers.moderate"]
        );
        expect(badItem === undefined || badItem.isError === true).toBe(true);
        expect(mocks.givePlayerItems).not.toHaveBeenCalled();
        expect(mocks.takePlayerItems).not.toHaveBeenCalled();
        expect(mocks.emptyPlayerInventory).not.toHaveBeenCalled();
        expect(mocks.sendPlayerInventory).not.toHaveBeenCalled();
    });

    it("stop and restart through the same functions as the page's buttons", async () => {
        await call("games_server_power", { serverId: GAME, action: "stop" }, [
            "gameservers.manage"
        ]);
        expect(mocks.gameServerAccess).toHaveBeenCalledWith(ADA, GAME, "games.manage");
        expect(mocks.setServerRunning).toHaveBeenCalledWith(ADA, STANDING, false);
        await call("games_server_power", { serverId: GAME, action: "restart" }, [
            "gameservers.manage"
        ]);
        expect(mocks.restartServerNow).toHaveBeenCalledWith(ADA, STANDING);
    });

    it("run the console only with the console grant on that server", async () => {
        mocks.runConsoleCommand.mockResolvedValue("There are 1 of a max of 20 players online");
        const result = await call("games_console", { serverId: GAME, command: "list" }, [
            "gameservers.manage"
        ]);
        expect(mocks.gameServerAccess).toHaveBeenCalledWith(ADA, GAME, "games.console");
        expect(mocks.runConsoleCommand).toHaveBeenCalledWith(ADA, STANDING, "list");
        expect(result.content[0]?.text).toContain("players online");

        mocks.gameServerAccess.mockResolvedValue(null);
        const refused = await call("games_console", { serverId: GAME, command: "op Steve" }, [
            "gameservers.manage"
        ]);
        expect(refused.content[0]?.text).toContain("cannot do that");
        expect(mocks.runConsoleCommand).toHaveBeenCalledTimes(1);
    });

    it("say the app's own refusal in words, and keep anything else to the log", async () => {
        mocks.setServerRunning.mockRejectedValueOnce(
            new Error(gameMessage("games", "errors.thisServerHasNotBeen"))
        );
        const said = await call("games_server_power", { serverId: GAME, action: "start" }, [
            "gameservers.manage"
        ]);
        expect(said.content[0]?.text).toBe("This server has not been deployed yet");

        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        mocks.setServerRunning.mockRejectedValueOnce(
            new Error("docker: socket hang up at /var/run")
        );
        const hidden = await call("games_server_power", { serverId: GAME, action: "start" }, [
            "gameservers.manage"
        ]);
        expect(hidden.content[0]?.text).not.toContain("/var/run");
        errors.mockRestore();
    });
});
