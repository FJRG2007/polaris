/**
 * A UPS handed out as a link: a watching link reads it and never drives it, a
 * control link sends its commands - fenced, rate-limited, counted - and none
 * of it ever shows a guest where the UPS is reached.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const UPS = "11111111-1111-4111-8111-111111111111";
const AT_RACK = { latitude: 51.5007, longitude: -0.1246 };

let reach: unknown = null;
let limited = { ok: true, retryAfterMs: 0 };
const runUpsCommand = vi.fn(async () => "ok" as const);
const spendGrant = vi.fn(async () => true);

vi.mock("@/lib/access/grants", () => ({
    linkReach: async () => reach,
    spendGrant,
    liveGrants: async () => []
}));
vi.mock("@/lib/session", () => ({ sessionCan: async () => false }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => limited }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/ups/ups-data", () => ({ logAction: async () => undefined }));
vi.mock("@polaris/db", () => ({ prisma: { place: { findUnique: async () => AT_RACK } } }));
vi.mock("@/lib/ups/ups-service", () => ({
    getUps: async () => ({ id: UPS, name: "Rack", placeId: "p1", host: "10.0.0.5" }),
    readUps: async () => ({
        ok: true,
        reading: {
            status: { online: true },
            charge: 98,
            runtimeS: 1800,
            load: 20,
            testResult: null,
            commands: ["test.battery.start.quick", "load.off"]
        }
    }),
    runUpsCommand
}));

const { pressUpsGuest, upsGuestView } = await import("@/lib/ups/ups-guest");

function live(actions: string[], nearbyMeters: number | null = null) {
    return {
        standing: "live",
        subjectType: "place.ups",
        subjectId: UPS,
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

describe("what a UPS link shows", () => {
    it("is its name and how it is doing, never where it is reached", async () => {
        reach = live(["watch"]);
        const view = await upsGuestView("t");
        expect(view?.name).toBe("Rack");
        expect(view?.reading?.charge).toBe(98);
        expect(JSON.stringify(view)).not.toContain("10.0.0.5");
    });

    it("lists no commands for a watching link", async () => {
        reach = live(["watch"]);
        expect((await upsGuestView("t"))?.commands).toEqual([]);
    });

    it("lists the UPS's commands for a control link", async () => {
        reach = live(["watch", "control"]);
        expect((await upsGuestView("t"))?.commands).toContain("test.battery.start.quick");
    });

    it("is nothing for a door's link, or one taken back", async () => {
        reach = { ...live(["open"]), subjectType: "place.device" };
        expect(await upsGuestView("t")).toBeNull();
        reach = null;
        expect(await upsGuestView("t")).toBeNull();
    });
});

describe("driving a UPS through a link", () => {
    it("refuses a watching link", async () => {
        reach = live(["watch"]);
        expect(await pressUpsGuest("t", "load.off", null, "1.2.3.4")).toEqual({
            ok: false,
            error: "notThat"
        });
        expect(runUpsCommand).not.toHaveBeenCalled();
    });

    it("sends a control link's command and counts it", async () => {
        reach = live(["watch", "control"]);
        expect(await pressUpsGuest("t", "test.battery.start.quick", null, "1.2.3.4")).toEqual({
            ok: true,
            outcome: "ok"
        });
        expect(spendGrant).toHaveBeenCalledOnce();
    });

    it("stops an address that sends too often", async () => {
        reach = live(["watch", "control"]);
        limited = { ok: false, retryAfterMs: 1 };
        expect(await pressUpsGuest("t", "load.off", null, "1.2.3.4")).toEqual({
            ok: false,
            error: "tooMany"
        });
    });

    it("asks where the browser is for a fenced link, and refuses it far away", async () => {
        reach = live(["watch", "control"], 100);
        expect(await pressUpsGuest("t", "load.off", null, "1.2.3.4")).toEqual({
            ok: false,
            error: "nearbyUnasked"
        });
        expect(
            await pressUpsGuest(
                "t",
                "load.off",
                { latitude: 51.6, longitude: -0.1246, accuracy: 10 },
                "1.2.3.4"
            )
        ).toEqual({ ok: false, error: "nearbyFar" });
        expect(runUpsCommand).not.toHaveBeenCalled();
        expect(
            await pressUpsGuest("t", "load.off", { ...AT_RACK, accuracy: 10 }, "1.2.3.4")
        ).toEqual({ ok: true, outcome: "ok" });
    });

    it("refuses a link that is closed", async () => {
        reach = { standing: "expired", subjectType: "place.ups", subjectId: UPS, note: "" };
        expect(await pressUpsGuest("t", "load.off", null, "1.2.3.4")).toEqual({
            ok: false,
            error: "closed"
        });
    });
});
