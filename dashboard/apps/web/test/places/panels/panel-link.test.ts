/**
 * A wall panel handed out as a link reaches the devices on the panel and
 * nothing else: a press on any other device is refused before it is made.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PANEL = "00000000-0000-4000-8000-0000000000e1";
const LAMP = "00000000-0000-4000-8000-0000000000b1";
const DOOR = "00000000-0000-4000-8000-0000000000d1";

let reach: unknown = null;
const actOnDevice = vi.fn(async (_i: string, id: string) => ({ id, state: "on" }));
const panelHolds = vi.fn(async (_i: string, _p: string, id: string) => id === LAMP);
const SCENE = "00000000-0000-4000-8000-0000000000f1";
const OTHER_SCENE = "00000000-0000-4000-8000-0000000000f2";
const CAMERA = "00000000-0000-4000-8000-0000000000c9";
const panelHoldsAutomation = vi.fn(async (_i: string, _p: string, id: string) => id === SCENE);
const runAutomationNow = vi.fn(async () => undefined);
let contents: unknown = null;

vi.mock("@polaris/app-host", () => ({
    host: {
        session: { sessionCan: async () => false },
        accessGrants: {
            linkReach: async () => reach,
            recordGrantUse: async () => undefined,
            spendGrant: async () => true
        },
        rateLimitService: { rateLimit: async () => ({ ok: true, retryAfterMs: 0 }) },
        auditService: { recordAudit: async () => undefined }
    }
}));
vi.mock("@polaris/db", () => ({ prisma: { place: { findUnique: async () => null } } }));
vi.mock("@polaris-app/places/src/lib/access", () => ({
    homeInstall: async () => ({ id: "install-1" })
}));
vi.mock("@polaris-app/places/src/lib/panels", () => ({
    panelHolds,
    panelHoldsAutomation,
    panelPlaceId: async () => "place-1",
    panelContents: async () => contents
}));
vi.mock("@polaris-app/places/src/lib/automations", () => ({ runAutomationNow }));
vi.mock("@polaris-app/places/src/lib/talk", () => ({ endCameraTalk: async () => undefined }));
vi.mock("@polaris-app/places/src/lib/devices", () => ({
    getDevice: async (_i: string, id: string) => ({ id, name: "x", kind: "light", placeId: null }),
    actOnDevice
}));

const { guestPanel, pressGuestKey, runGuestAutomation } =
    await import("@polaris-app/places/src/lib/guest-key");

function live(subjectType: string, actions: string[], subjectId = PANEL, capability = "control") {
    return {
        standing: "live",
        subjectType,
        subjectId,
        note: "",
        grant: {
            id: "g1",
            capability,
            actions,
            until: null,
            counted: false,
            nearbyMeters: null
        }
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("a wall panel link", () => {
    it("switches a device on the panel", async () => {
        reach = live("place.panel", ["operate"]);
        await pressGuestKey("t", "turn-on", null, "1.2.3.4", LAMP);
        expect(actOnDevice).toHaveBeenCalledWith(
            "install-1",
            LAMP,
            "turn-on",
            "Guest link",
            undefined
        );
    });

    it("sets the brightness of a light on the panel", async () => {
        reach = live("place.panel", ["operate"]);
        const command = { action: "set-brightness" as const, level: 60 };
        await pressGuestKey("t", "set-brightness", null, "1.2.3.4", LAMP, command);
        expect(actOnDevice).toHaveBeenCalledWith(
            "install-1",
            LAMP,
            "set-brightness",
            "Guest link",
            command
        );
    });

    it("refuses a device that is not on the panel", async () => {
        reach = live("place.panel", ["open", "close", "operate"]);
        await expect(pressGuestKey("t", "unlock", null, "1.2.3.4", DOOR)).rejects.toThrow(
            "This link does not allow that"
        );
        expect(actOnDevice).not.toHaveBeenCalled();
    });

    it("refuses an action the link was not given", async () => {
        reach = live("place.panel", ["operate"]);
        panelHolds.mockResolvedValueOnce(true);
        await expect(pressGuestKey("t", "unlock", null, "1.2.3.4", DOOR)).rejects.toThrow(
            "This link does not allow that"
        );
        expect(actOnDevice).not.toHaveBeenCalled();
    });

    it("never takes a setting through the link of a single device", async () => {
        reach = live("place.device", ["operate"], LAMP);
        await expect(
            pressGuestKey("t", "set-brightness", null, "1.2.3.4", undefined, {
                action: "set-brightness",
                level: 60
            })
        ).rejects.toThrow("This link does not allow that");
        expect(actOnDevice).not.toHaveBeenCalled();
    });
});

describe("a wall panel link's automation buttons", () => {
    it("runs an automation the panel has a button for", async () => {
        reach = live("place.panel", ["operate"]);
        await runGuestAutomation("t", SCENE, null, "1.2.3.4");
        expect(runAutomationNow).toHaveBeenCalledWith(
            "install-1",
            SCENE,
            "Guest link",
            expect.any(String)
        );
    });

    it("refuses an automation that is not on the panel", async () => {
        reach = live("place.panel", ["operate"]);
        await expect(runGuestAutomation("t", OTHER_SCENE, null, "1.2.3.4")).rejects.toThrow(
            "This link does not allow that"
        );
        expect(runAutomationNow).not.toHaveBeenCalled();
    });

    it("refuses a link lent only to look, or without operate", async () => {
        reach = live("place.panel", ["operate"], PANEL, "view");
        await expect(runGuestAutomation("t", SCENE, null, "1.2.3.4")).rejects.toThrow(
            "This link does not allow that"
        );
        reach = live("place.panel", ["watch"]);
        await expect(runGuestAutomation("t", SCENE, null, "1.2.3.4")).rejects.toThrow(
            "This link does not allow that"
        );
        expect(runAutomationNow).not.toHaveBeenCalled();
    });

    it("never runs anything through a room's or a door's link", async () => {
        reach = live("place.room", ["operate"]);
        await expect(runGuestAutomation("t", SCENE, null, "1.2.3.4")).rejects.toThrow(
            "This link does not open anything right now"
        );
        expect(runAutomationNow).not.toHaveBeenCalled();
    });
});

describe("what a wall panel link shows", () => {
    const full = {
        panel: { id: PANEL, placeId: "place-1", name: "Hall", cards: [] },
        devices: [],
        rooms: [],
        cameras: [
            {
                id: CAMERA,
                name: "Porch",
                privacy: false,
                address: "192.0.2.10",
                username: "admin",
                mainPath: "/stream1"
            }
        ],
        automations: [{ id: SCENE, name: "Good night", enabled: true }]
    };

    it("shows a camera by name only, and only when lent to watch", async () => {
        contents = full;
        reach = live("place.panel", ["watch", "operate"]);
        const seen = await guestPanel("t");
        expect(seen && seen.standing === "live" && seen.cameras).toEqual([
            { id: CAMERA, name: "Porch", private: false }
        ]);
        expect(JSON.stringify(seen)).not.toContain("192.0.2.10");
        reach = live("place.panel", ["operate"]);
        const blind = await guestPanel("t");
        expect(blind && blind.standing === "live" && blind.cameras).toEqual([]);
    });

    it("lists its automation buttons only for a link that may run them", async () => {
        contents = full;
        reach = live("place.panel", ["operate"]);
        const runs = await guestPanel("t");
        expect(runs && runs.standing === "live" && runs.automations).toHaveLength(1);
        reach = live("place.panel", ["operate"], PANEL, "view");
        const looks = await guestPanel("t");
        expect(looks && looks.standing === "live" && looks.automations).toEqual([]);
    });
});
