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
    panelContents: async () => null
}));
vi.mock("@polaris-app/places/src/lib/devices", () => ({
    getDevice: async (_i: string, id: string) => ({ id, name: "x", kind: "light", placeId: null }),
    actOnDevice
}));

const { pressGuestKey } = await import("@polaris-app/places/src/lib/guest-key");

function live(subjectType: string, actions: string[], subjectId = PANEL) {
    return {
        standing: "live",
        subjectType,
        subjectId,
        note: "",
        grant: {
            id: "g1",
            capability: "control",
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
