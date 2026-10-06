/**
 * What Places' device tools tell a model about how current a state is.
 *
 * A lock's bolt and its door are said apart ("lock: locked, door: closed",
 * "door sensor: none"), every device says how old its reading is, a reading
 * older than its account's turn - or a device still moving - is read again
 * first within a few seconds, and a command answers with what the device
 * reported afterwards, or says it is not confirmed yet.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    actingUser: vi.fn(),
    homeInstall: vi.fn(),
    listDevices: vi.fn(),
    getDevice: vi.fn(),
    listPlaces: vi.fn(),
    placesReach: vi.fn(),
    operateDevice: vi.fn(),
    listAccounts: vi.fn(),
    refreshAccounts: vi.fn(),
    currentInterval: vi.fn(),
    waitForRead: vi.fn()
}));

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/mcp/acting-user", () => ({ actingUser: mocks.actingUser }));
vi.mock("@/lib/i18n/request", () => ({ getLocale: async () => "en-US" }));
vi.mock("@polaris-app/places/src/lib/access", () => ({ homeInstall: mocks.homeInstall }));
vi.mock("@polaris-app/places/src/lib/devices", () => ({
    listDevices: mocks.listDevices,
    getDevice: mocks.getDevice
}));
vi.mock("@polaris-app/places/src/lib/places", () => ({ listPlaces: mocks.listPlaces }));
vi.mock("@polaris-app/places/src/lib/sharing", () => ({
    placesReach: mocks.placesReach,
    requireCameraView: vi.fn(),
    onlyReachable: <T extends { id: string }>(
        things: T[],
        allowed: true | ReadonlyMap<string, unknown>
    ) => (allowed === true ? things : things.filter((thing) => allowed.has(thing.id)))
}));
vi.mock("@polaris-app/places/src/lib/device-operation", () => ({
    operateDevice: mocks.operateDevice
}));
vi.mock("@polaris-app/places/src/lib/device-accounts", () => ({
    listAccounts: mocks.listAccounts,
    isConnectable: () => true
}));
vi.mock("@polaris-app/places/src/lib/device-watch", () => ({
    refreshAccounts: mocks.refreshAccounts,
    currentInterval: mocks.currentInterval,
    waitForRead: mocks.waitForRead
}));

const { placesExtension } = await import("@polaris-app/places/src/lib/places-extension");
const { handleMcpMessage } = await import("@/lib/mcp/protocol");

const TOOLS = await placesExtension.mcpTools!();
const SERVER = { name: "polaris", version: "1", instructions: "" };
const ADA = { id: "user-1", email: "ada@example.test", name: "Ada", isAdmin: false, sessionId: "" };
const INSTALL = { id: "install-1", ownerId: "owner-1", name: "Home" };
const DOOR = "11111111-1111-4111-8111-111111111111";
const LAMP = "22222222-2222-4222-8222-222222222222";

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

function secondsAgo(seconds: number): string {
    return new Date(Date.now() - seconds * 1000).toISOString();
}

function device(id: string, kind: string, extra: Record<string, unknown> = {}) {
    return {
        id,
        vendor: "acme",
        kind,
        name: kind === "lock" ? "Front door" : "Lamp",
        zone: "Hall",
        placeId: "place-1",
        model: "",
        firmware: "",
        state: kind === "lock" ? "locked" : "on",
        doorState: "none",
        batteryPercent: 80,
        batteryCritical: false,
        online: true,
        controllable: true,
        reading: null,
        stateAt: secondsAgo(5),
        accountId: "account-1",
        ...extra
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.actingUser.mockResolvedValue(ADA);
    mocks.homeInstall.mockResolvedValue(INSTALL);
    mocks.listPlaces.mockResolvedValue([{ id: "place-1", name: "Flat" }]);
    mocks.placesReach.mockResolvedValue({ everything: true, devices: new Map() });
    mocks.listAccounts.mockResolvedValue([{ id: "account-1", connection: "nuki-web" }]);
    mocks.currentInterval.mockReturnValue(60_000);
    mocks.refreshAccounts.mockResolvedValue("read");
    mocks.waitForRead.mockResolvedValue(true);
});

describe("places_devices", () => {
    it("says a lock's bolt and its door apart, and how old the reading is", async () => {
        mocks.listDevices.mockResolvedValue([
            device(DOOR, "lock", { doorState: "closed" }),
            device(LAMP, "light")
        ]);
        const result = await call("places_devices", {}, ["places.read"]);
        const [door, lamp] = result.content[0]!.text.split("\n");
        expect(door).toContain("lock: locked, door: closed");
        expect(door).toMatch(/as of \ds ago/);
        expect(lamp).toContain("state: on");
        expect(result.structuredContent.devices[0]).toMatchObject({
            lock: "locked",
            doorSensor: "closed",
            door: "closed"
        });
    });

    it("says there is no door sensor rather than leaving it out", async () => {
        mocks.listDevices.mockResolvedValue([device(DOOR, "lock")]);
        const result = await call("places_devices", {}, ["places.read"]);
        expect(result.content[0]!.text).toContain("lock: locked, door sensor: none");
        expect(result.structuredContent.devices[0]).toMatchObject({ doorSensor: "none" });
    });

    it("tells the model the lock state is not the door", () => {
        const tool = TOOLS.find((one) => one.name === "places_devices")!;
        expect(tool.description).toContain("never whether the door is open");
    });

    it("leaves a reading younger than its account's turn alone", async () => {
        mocks.listDevices.mockResolvedValue([device(DOOR, "lock")]);
        await call("places_devices", {}, ["places.read"]);
        expect(mocks.refreshAccounts).not.toHaveBeenCalled();
    });

    it("reads an account again first when its reading is older than its turn, then answers what it read", async () => {
        mocks.listDevices
            .mockResolvedValueOnce([device(DOOR, "lock", { stateAt: secondsAgo(3600) })])
            .mockResolvedValueOnce([device(DOOR, "lock", { state: "unlocked" })]);
        const result = await call("places_devices", {}, ["places.read"]);
        expect(mocks.refreshAccounts).toHaveBeenCalledWith(INSTALL.id, ["account-1"], 4000);
        expect(result.content[0]!.text).toContain("lock: unlocked");
        expect(result.structuredContent.fresh).toBe(true);
    });

    it("reads a device still moving again, whatever its age", async () => {
        mocks.listDevices.mockResolvedValue([device(DOOR, "lock", { state: "moving" })]);
        await call("places_devices", {}, ["places.read"]);
        expect(mocks.refreshAccounts).toHaveBeenCalled();
    });

    it("answers with the last reading and its age when the account does not answer in time", async () => {
        mocks.refreshAccounts.mockResolvedValue("timeout");
        mocks.listDevices.mockResolvedValue([device(DOOR, "lock", { stateAt: secondsAgo(600) })]);
        const result = await call("places_devices", {}, ["places.read"]);
        expect(mocks.listDevices).toHaveBeenCalledTimes(1);
        expect(result.content[0]!.text).toContain("as of 10 min ago");
        expect(result.content[0]!.text).toContain("Could not read them again just now");
        expect(result.structuredContent.fresh).toBe(false);
    });

    it("never makes a visitor's call read the house's accounts", async () => {
        mocks.placesReach.mockResolvedValue({
            everything: false,
            devices: new Map([[DOOR, "view"]])
        });
        mocks.listDevices.mockResolvedValue([device(DOOR, "lock", { stateAt: secondsAgo(3600) })]);
        await call("places_devices", {}, ["places.read"]);
        expect(mocks.refreshAccounts).not.toHaveBeenCalled();
    });
});

describe("places_device_control", () => {
    it("answers with the state the device reported after the command", async () => {
        mocks.operateDevice.mockResolvedValue(device(DOOR, "lock", { state: "moving" }));
        mocks.getDevice.mockResolvedValue(
            device(DOOR, "lock", { state: "locked", doorState: "closed" })
        );
        const result = await call("places_device_control", { deviceId: DOOR, action: "lock" }, [
            "places.control"
        ]);
        expect(mocks.waitForRead).toHaveBeenCalledWith(
            "account-1",
            expect.any(Number),
            expect.any(Number)
        );
        expect(result.content[0]!.text).toBe(
            "Front door: lock: locked, door: closed - confirmed by the device."
        );
        expect(result.structuredContent.confirmed).toBe(true);
    });

    it("says the command was sent and not yet confirmed when no read comes in time", async () => {
        mocks.operateDevice.mockResolvedValue(device(DOOR, "lock", { state: "moving" }));
        mocks.waitForRead.mockResolvedValue(false);
        const result = await call("places_device_control", { deviceId: DOOR, action: "lock" }, [
            "places.control"
        ]);
        expect(result.content[0]!.text).toBe(
            "Front door: sent, not yet confirmed (last known lock: moving, door sensor: none)."
        );
        expect(result.structuredContent.confirmed).toBe(false);
    });
});
