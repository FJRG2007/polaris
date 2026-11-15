/**
 * Places' device tools wherever Polar runs: in the chat for a person who holds
 * the Places permissions, on an agent session's connection for the person it
 * works for, and never for somebody who holds neither. Operating a device waits
 * for approval, and switching a dehumidifier off reaches the device.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    held: new Set<string>(),
    actingUser: vi.fn(),
    homeInstall: vi.fn(),
    listDevices: vi.fn(),
    getDevice: vi.fn(),
    placesReach: vi.fn(),
    operateDevice: vi.fn(),
    requireDeviceControl: vi.fn()
}));

vi.mock("@polaris/db", () => ({ prisma: { polarToolGrant: { findMany: async () => [] } } }));
vi.mock("@/lib/session", () => ({
    sessionCan: async (_user: unknown, permission: string) => mocks.held.has(permission)
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/mcp/acting-user", () => ({ actingUser: mocks.actingUser }));
vi.mock("@/lib/i18n/request", () => ({ getLocale: async () => "en-US" }));
vi.mock("@polaris-app/places/src/lib/access", () => ({ homeInstall: mocks.homeInstall }));
vi.mock("@polaris-app/places/src/lib/devices", () => ({
    listDevices: mocks.listDevices,
    getDevice: mocks.getDevice
}));
vi.mock("@polaris-app/places/src/lib/places", () => ({ listPlaces: async () => [] }));
vi.mock("@polaris-app/places/src/lib/sharing", () => ({
    placesReach: mocks.placesReach,
    requireDeviceControl: mocks.requireDeviceControl,
    requireCameraView: vi.fn(),
    onlyReachable: <T>(things: T[]) => things
}));
vi.mock("@polaris-app/places/src/lib/device-operation", () => ({
    operateDevice: mocks.operateDevice
}));
vi.mock("@polaris-app/places/src/lib/device-accounts", () => ({
    listAccounts: async () => [],
    isConnectable: () => true
}));
vi.mock("@polaris-app/places/src/lib/device-watch", () => ({
    refreshAccounts: async () => "read",
    currentInterval: () => 60_000,
    waitForRead: async () => false
}));

const { placesExtension } = await import("@polaris-app/places/src/lib/places-extension");
const PLACES_TOOLS = await placesExtension.mcpTools!();
vi.mock("@/lib/app-extensions/registry", () => ({
    appMcpTools: async () => PLACES_TOOLS.map((tool) => ({ app: "home", tool }))
}));

const { polarTools } = await import("@/lib/polar/tools");
const { heldSessionScopes } = await import("@/lib/mcp/session-scopes");
const { rankTools } = await import("@/lib/polar/tool-relevance");

const ADA = { id: "u1", email: "ada@example.test", name: "Ada", isAdmin: false, sessionId: "" };
const DRYER = "33333333-3333-4333-8333-333333333333";

function dehumidifier(state: string) {
    return {
        id: DRYER,
        vendor: "midea",
        kind: "dehumidifier",
        name: "Dehumidifier",
        zone: "Bedroom",
        placeId: "place-1",
        model: "",
        firmware: "",
        state,
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: true,
        controllable: true,
        reading: null,
        stateAt: new Date().toISOString(),
        accountId: "account-1"
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.held.clear();
    mocks.actingUser.mockResolvedValue(ADA);
    mocks.homeInstall.mockResolvedValue({ id: "install-1", ownerId: "u1", name: "Home" });
    mocks.placesReach.mockResolvedValue({ everything: true, devices: new Map() });
    mocks.requireDeviceControl.mockResolvedValue(null);
    mocks.getDevice.mockResolvedValue(dehumidifier("on"));
});

describe("Places tools in the chat", () => {
    it("offers seeing and operating devices to a person who holds the Places permissions", async () => {
        mocks.held.add("home.read").add("home.control");
        const set = await polarTools(ADA as never);
        expect(Object.keys(set.tools)).toEqual(
            expect.arrayContaining(["places_devices", "places_device_control"])
        );
        // Operating one waits for the person's yes on a card.
        expect(await set.approval.places_device_control!({ deviceId: DRYER, action: "turn-off" })).toBe(
            "user-approval"
        );
        expect(set.approval.places_devices).toBeUndefined();
        // find_tools turns them up by name and by what they do.
        const found = (query: string) => rankTools(set.catalog, query).map((entry) => entry.name);
        expect(found("devices")).toContain("places_devices");
        expect(found("turn off a device")).toContain("places_device_control");
    });

    it("offers none of them to somebody without Places", async () => {
        const set = await polarTools(ADA as never);
        expect(Object.keys(set.tools).filter((name) => name.startsWith("places_"))).toEqual([]);
    });

    it("switches a dehumidifier off once approved, and says what the device reports", async () => {
        mocks.held.add("home.read").add("home.control");
        mocks.operateDevice.mockResolvedValue(dehumidifier("off"));
        const set = await polarTools(ADA as never);
        const control = set.tools.places_device_control as unknown as {
            execute: (input: unknown, options: unknown) => Promise<{ ok: boolean; text: string }>;
        };
        const answer = await control.execute({ deviceId: DRYER, action: "turn-off" }, {});
        expect(mocks.operateDevice).toHaveBeenCalledWith(
            ADA,
            "install-1",
            DRYER,
            "turn-off",
            undefined
        );
        expect(answer.ok).toBe(true);
        expect(answer.text).toContain("Dehumidifier");
    });
});

describe("Places scopes on an agent session's connection", () => {
    it("lends a session the device scopes its person holds", async () => {
        mocks.held.add("home.read").add("home.control");
        expect(await heldSessionScopes("u1")).toEqual(["places.read", "places.control"]);
        mocks.held.delete("home.control");
        expect(await heldSessionScopes("u1")).toEqual(["places.read"]);
    });

    it("lends none to a person without Places, or an account that is gone", async () => {
        expect(await heldSessionScopes("u1")).toEqual([]);
        mocks.held.add("home.read").add("home.control");
        mocks.actingUser.mockResolvedValue(null);
        expect(await heldSessionScopes("u1")).toEqual([]);
    });
});
