/**
 * A door opened through a link by somebody with no account. Every press is
 * judged again: what the link allows, whether it is in force, how near the
 * browser is, and how often this address has pressed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const DOOR = "00000000-0000-4000-8000-0000000000d1";
const PLACE = "00000000-0000-4000-8000-0000000000a1";
/** A front door, and a browser standing at it and one across town. */
const AT_DOOR = { latitude: 40.4168, longitude: -3.7038 };
const HERE = { ...AT_DOOR, accuracy: 10 };
const ACROSS_TOWN = { latitude: 40.45, longitude: -3.7038, accuracy: 10 };

let reach: unknown = null;
let limited = { ok: true, retryAfterMs: 0 };
const actOnDevice = vi.fn(async () => ({ id: DOOR, name: "Front door", state: "unlocked" }));
const spendGrant = vi.fn(async () => true);
const recordAudit = vi.fn(async () => undefined);
const recordGrantUse = vi.fn(async (_use: Record<string, unknown>) => undefined);

vi.mock("@polaris/app-host", () => ({
    host: {
        session: { sessionCan: async () => false },
        accessGrants: {
            linkReach: async () => reach,
            recordGrantUse,
            spendGrant,
            grantedActions: async () => new Map(),
            grantedSubjects: async () => new Map(),
            liveGrants: async () => [],
            reachesAnySubject: async () => false
        },
        rateLimitService: { rateLimit: async () => limited },
        auditService: { recordAudit }
    }
}));
vi.mock("@polaris/db", () => ({
    prisma: { place: { findUnique: async () => AT_DOOR } }
}));
vi.mock("@polaris-app/places/src/lib/access", () => ({
    homeInstall: async () => ({ id: "install-1" })
}));
vi.mock("@polaris-app/places/src/lib/devices", () => ({
    getDevice: async () => ({ id: DOOR, name: "Front door", kind: "lock", placeId: PLACE }),
    actOnDevice
}));

const { pressGuestKey } = await import("@polaris-app/places/src/lib/guest-key");
const { NearbyRefusal } = await import("@polaris-app/places/src/lib/nearby");

function live(actions: string[], nearbyMeters: number | null = null) {
    return {
        standing: "live",
        subjectType: "place.device",
        subjectId: DOOR,
        note: "",
        grant: {
            id: "g1",
            capability: "control",
            actions,
            until: null,
            counted: true,
            nearbyMeters
        }
    };
}

beforeEach(() => {
    reach = null;
    limited = { ok: true, retryAfterMs: 0 };
    vi.clearAllMocks();
});

describe("a press through a link", () => {
    it("opens a door lent to be opened, and counts the use after", async () => {
        reach = live(["open"]);
        await pressGuestKey("t", "unlock", null, "1.2.3.4");
        expect(actOnDevice).toHaveBeenCalledOnce();
        expect(spendGrant).toHaveBeenCalledOnce();
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({ actorId: null, action: "places.device.unlock" })
        );
    });

    it("does not lock a door lent only to be opened", async () => {
        reach = live(["open"]);
        await expect(pressGuestKey("t", "lock", null, "1.2.3.4")).rejects.toThrow(
            "This link does not allow that"
        );
        expect(actOnDevice).not.toHaveBeenCalled();
    });

    it("opens nothing once the link is taken back, or out of its hours", async () => {
        reach = null;
        await expect(pressGuestKey("t", "unlock", null, "1.2.3.4")).rejects.toThrow();
        reach = { standing: "closed", subjectType: "place.device", subjectId: DOOR, note: "" };
        await expect(pressGuestKey("t", "unlock", null, "1.2.3.4")).rejects.toThrow();
        expect(actOnDevice).not.toHaveBeenCalled();
    });

    it("does not open a UPS link's subject as a door", async () => {
        reach = { ...live(["control"]), subjectType: "place.ups" };
        await expect(pressGuestKey("t", "unlock", null, "1.2.3.4")).rejects.toThrow();
    });

    it("stops an address that presses too often", async () => {
        reach = live(["open"]);
        limited = { ok: false, retryAfterMs: 30_000 };
        await expect(pressGuestKey("t", "unlock", null, "1.2.3.4")).rejects.toThrow(
            "Too many presses"
        );
        expect(actOnDevice).not.toHaveBeenCalled();
    });

    it("does not count a use when the door would not move", async () => {
        reach = live(["open"]);
        actOnDevice.mockRejectedValueOnce(new Error("offline"));
        await expect(pressGuestKey("t", "unlock", null, "1.2.3.4")).rejects.toThrow();
        expect(spendGrant).not.toHaveBeenCalled();
    });
});

describe("a link fenced to the place", () => {
    it("asks for the browser's location first", async () => {
        reach = live(["open"], 100);
        const refused = await pressGuestKey("t", "unlock", null, "1.2.3.4").catch((e) => e);
        expect(refused).toBeInstanceOf(NearbyRefusal);
        expect((refused as InstanceType<typeof NearbyRefusal>).verdict).toBe("unasked");
        expect(actOnDevice).not.toHaveBeenCalled();
    });

    it("opens for somebody at the door", async () => {
        reach = live(["open"], 100);
        await pressGuestKey("t", "unlock", HERE, "1.2.3.4");
        expect(actOnDevice).toHaveBeenCalledOnce();
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({ metadata: expect.objectContaining({ nearby: true }) })
        );
    });

    it("refuses somebody across town, and never records where they were", async () => {
        reach = live(["open"], 100);
        const refused = await pressGuestKey("t", "unlock", ACROSS_TOWN, "1.2.3.4").catch((e) => e);
        expect((refused as InstanceType<typeof NearbyRefusal>).verdict).toBe("far");
        expect(actOnDevice).not.toHaveBeenCalled();
        expect(JSON.stringify(recordAudit.mock.calls)).not.toContain("40.45");
    });
});

describe("the access log of a link", () => {
    it("records an open that worked, with the link's purpose", async () => {
        reach = { ...live(["open"]), note: "Room 12 guest" };
        await pressGuestKey("t", "unlock", null, "1.2.3.4");
        expect(recordGrantUse).toHaveBeenCalledWith(
            expect.objectContaining({
                grantId: "g1",
                targetId: DOOR,
                userId: null,
                linkNote: "Room 12 guest",
                action: "unlock",
                outcome: "done"
            })
        );
    });

    it("records a refusal and why", async () => {
        reach = live(["open"]);
        await expect(pressGuestKey("t", "lock", null, "1.2.3.4")).rejects.toThrow();
        expect(recordGrantUse).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: "refused", reason: "notThat" })
        );
        reach = { ...live(["open"]), standing: "expired" };
        await expect(pressGuestKey("t", "unlock", null, "1.2.3.4")).rejects.toThrow();
        expect(recordGrantUse).toHaveBeenLastCalledWith(
            expect.objectContaining({ outcome: "refused", reason: "expired", grantId: null })
        );
    });
});
