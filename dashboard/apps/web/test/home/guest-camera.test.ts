/**
 * A camera watched through a link by somebody with no account: opening the
 * view is one use, every picture after it rides on the watch it was given,
 * and each picture still asks the link whether it is in force.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const YARD = "00000000-0000-4000-8000-0000000000c1";

let reach: unknown = null;
let paid: unknown = null;
let limited = { ok: true, retryAfterMs: 0 };
const spendGrant = vi.fn(async () => true);
const recordAudit = vi.fn(async () => undefined);
const recordGrantUse = vi.fn(async (_use: Record<string, unknown>) => undefined);
let roomCameras = new Map<string, string>();
let yardPrivate = false;

vi.mock("@polaris/app-host", () => ({
    host: {
        accessGrants: {
            linkReach: async () => reach,
            linkReachPaid: async () => paid,
            recordGrantUse,
            spendGrant
        },
        rateLimitService: { rateLimit: async () => limited },
        auditService: { recordAudit }
    }
}));
vi.mock("@polaris-app/places/src/lib/access", () => ({
    homeInstall: async () => ({ id: "install-1" })
}));
vi.mock("@polaris-app/places/src/lib/sharing", () => ({
    roomContents: async () => ({ devices: new Map(), cameras: roomCameras }),
    isThingId: (value: string) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}));
vi.mock("@polaris-app/places/src/lib/panels", () => ({ panelHoldsCamera: async () => false }));
vi.mock("@polaris-app/places/src/lib/cameras", () => ({
    getCamera: async (_install: string, id: string) =>
        id === YARD
            ? { id: YARD, name: "Yard", address: "rtsp://10.0.0.9/live", privacy: yardPrivate }
            : null
}));

const {
    forgetWatches,
    guestCamera,
    guestWatchCamera,
    guestWatchState,
    openGuestWatch,
    RECHECK_MS,
    WATCH_TTL_MS,
    whileLinkHolds
} = await import("@polaris-app/places/src/lib/guest-camera");

function live(subjectType = "place.camera", id = "g1") {
    return {
        standing: "live",
        subjectType,
        subjectId: YARD,
        note: "",
        grant: { id, capability: "view", actions: ["watch"], until: null, counted: true }
    };
}

beforeEach(() => {
    reach = null;
    paid = null;
    limited = { ok: true, retryAfterMs: 0 };
    forgetWatches();
    yardPrivate = false;
    vi.clearAllMocks();
});

describe("what a camera link shows", () => {
    it("is the camera's name, never where it is reached", async () => {
        reach = live();
        const seen = await guestCamera("t");
        expect(seen).toMatchObject({ standing: "live", name: "Yard" });
        expect(JSON.stringify(seen)).not.toContain("10.0.0.9");
    });

    it("says why a link out of hours, expired or spent opens nothing", async () => {
        for (const standing of ["closed", "expired", "spent"]) {
            reach = { ...live(), standing };
            expect(await guestCamera("t")).toEqual({ standing });
        }
    });

    it("is nothing for a door's link, or one taken back", async () => {
        reach = live("place.device");
        expect(await guestCamera("t")).toBeNull();
        reach = null;
        expect(await guestCamera("t")).toBeNull();
    });
});

describe("opening the live view", () => {
    it("spends one use and hands back a watch the pictures take", async () => {
        reach = live();
        paid = live();
        const opened = await openGuestWatch("t", "1.2.3.4");
        expect(opened.ok).toBe(true);
        expect(spendGrant).toHaveBeenCalledTimes(1);
        const watch = opened.ok ? opened.watch : "";
        // Frames and segments: many requests, no further use.
        for (let i = 0; i < 5; i += 1) {
            expect(await guestWatchCamera("t", watch)).toEqual({
                installId: "install-1",
                cameraId: YARD
            });
        }
        expect(spendGrant).toHaveBeenCalledTimes(1);
    });

    it("refuses a link out of hours, expired, spent or taken back", async () => {
        for (const standing of ["closed", "expired", "spent"]) {
            reach = { ...live(), standing };
            expect(await openGuestWatch("t", "1.2.3.4")).toEqual({ ok: false, error: "closed" });
        }
        reach = null;
        expect(await openGuestWatch("t", "1.2.3.4")).toEqual({ ok: false, error: "closed" });
        expect(spendGrant).not.toHaveBeenCalled();
    });

    it("refuses when the last use went to somebody else first", async () => {
        reach = live();
        spendGrant.mockResolvedValueOnce(false);
        expect(await openGuestWatch("t", "1.2.3.4")).toEqual({ ok: false, error: "closed" });
    });

    it("is rate-limited per link and address", async () => {
        reach = live();
        limited = { ok: false, retryAfterMs: 1000 };
        expect(await openGuestWatch("t", "1.2.3.4")).toEqual({ ok: false, error: "tooMany" });
    });
});

describe("each picture", () => {
    async function opened(): Promise<string> {
        reach = live();
        const answer = await openGuestWatch("t", "1.2.3.4", 1_000);
        return answer.ok ? answer.watch : "";
    }

    it("stops the moment the link is taken back or out of hours", async () => {
        const watch = await opened();
        paid = null;
        expect(await guestWatchCamera("t", watch, 2_000)).toBeNull();
        paid = { ...live(), standing: "closed" };
        expect(await guestWatchCamera("t", watch, 2_000)).toBeNull();
    });

    it("needs a watch opened through this link, and one not run out", async () => {
        const watch = await opened();
        paid = live();
        expect(await guestWatchCamera("t", "x".repeat(22), 2_000)).toBeNull();
        paid = live("place.camera", "another-grant");
        expect(await guestWatchCamera("t", watch, 2_000)).toBeNull();
        paid = live();
        expect(await guestWatchCamera("t", watch, 1_000 + WATCH_TTL_MS)).toBeNull();
    });

    it("never controls anything: a camera link carries only watching", async () => {
        const core = await import("@polaris/core");
        expect(core.linkCapabilities("place.camera")).toEqual(["view"]);
        expect(core.grantActions("place.camera", "view", [])).toEqual(["watch"]);
    });
});

describe("a stream already flowing", () => {
    it("ends once the link is taken back, on the next check", async () => {
        vi.useFakeTimers();
        let holds = true;
        const upstream = new ReadableStream<Uint8Array>({
            pull: (controller) => controller.enqueue(new Uint8Array([1]))
        });
        const flowing = whileLinkHolds(new Response(upstream), "t", "w", async () =>
            holds ? { installId: "i", cameraId: YARD } : null
        );
        const reader = flowing.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        holds = false;
        await vi.advanceTimersByTimeAsync(RECHECK_MS + 1);
        let done = false;
        for (let i = 0; i < 50 && !done; i += 1) done = (await reader.read()).done;
        expect(done).toBe(true);
        vi.useRealTimers();
    });
});

describe("the access log of a camera link", () => {
    it("records a view opened, and one refused", async () => {
        reach = live();
        await openGuestWatch("t", "1.2.3.4");
        expect(recordGrantUse).toHaveBeenCalledWith(
            expect.objectContaining({ targetId: YARD, action: "watch", outcome: "done" })
        );
        reach = { ...live(), standing: "closed" };
        await openGuestWatch("t", "1.2.3.4");
        expect(recordGrantUse).toHaveBeenLastCalledWith(
            expect.objectContaining({ outcome: "refused", reason: "closed" })
        );
    });

    it("opens a camera in a room's link only when it is in the room", async () => {
        reach = { ...live("place.room"), subjectId: "room-1" };
        roomCameras = new Map();
        expect(await openGuestWatch("t", "1.2.3.4", Date.now(), YARD)).toEqual({
            ok: false,
            error: "closed"
        });
        roomCameras = new Map([[YARD, "room-1"]]);
        expect((await openGuestWatch("t", "1.2.3.4", Date.now(), YARD)).ok).toBe(true);
    });

    it("shows none of a room's cameras when the room was lent without watch", async () => {
        const door = { ...live("place.room"), subjectId: "room-1" };
        reach = { ...door, grant: { ...door.grant, actions: ["open"] } };
        roomCameras = new Map([[YARD, "room-1"]]);
        expect(await openGuestWatch("t", "1.2.3.4", Date.now(), YARD)).toEqual({
            ok: false,
            error: "closed"
        });
        expect(spendGrant).not.toHaveBeenCalled();
    });

    it("stops a room's picture once watch is taken off the room's key", async () => {
        const room = { ...live("place.room"), subjectId: "room-1" };
        roomCameras = new Map([[YARD, "room-1"]]);
        reach = room;
        paid = room;
        const opened = await openGuestWatch("t", "1.2.3.4", Date.now(), YARD);
        const watch = opened.ok ? opened.watch : "";
        expect(await guestWatchCamera("t", watch)).not.toBeNull();
        paid = { ...room, grant: { ...room.grant, actions: ["open"] } };
        expect(await guestWatchCamera("t", watch)).toBeNull();
    });

    it("logs a refused link only for a camera it holds, and only within the rate limit", async () => {
        reach = { ...live("place.room"), subjectId: "room-1", standing: "expired" };
        roomCameras = new Map([[YARD, "room-1"]]);
        await openGuestWatch("t", "1.2.3.4", Date.now(), "not-an-id");
        await openGuestWatch("t", "1.2.3.4", Date.now(), "00000000-0000-4000-8000-0000000000c2");
        expect(recordGrantUse).not.toHaveBeenCalled();
        await openGuestWatch("t", "1.2.3.4", Date.now(), YARD);
        expect(recordGrantUse).toHaveBeenCalledTimes(1);
        limited = { ok: false, retryAfterMs: 1000 };
        expect(await openGuestWatch("t", "1.2.3.4", Date.now(), YARD)).toEqual({
            ok: false,
            error: "tooMany"
        });
        expect(recordGrantUse).toHaveBeenCalledTimes(1);
    });
});

describe("a camera in privacy mode", () => {
    it("is shown as private, on its own link and in a room's", async () => {
        reach = live();
        yardPrivate = true;
        expect(await guestCamera("t")).toMatchObject({ standing: "live", private: true });
    });

    it("opens nothing, spends no use, and logs why", async () => {
        reach = live();
        yardPrivate = true;
        expect(await openGuestWatch("t", "1.2.3.4")).toEqual({ ok: false, error: "private" });
        expect(spendGrant).not.toHaveBeenCalled();
        expect(recordGrantUse).toHaveBeenLastCalledWith(
            expect.objectContaining({ outcome: "refused", reason: "private" })
        );
        reach = { ...live("place.room"), subjectId: "room-1" };
        roomCameras = new Map([[YARD, "room-1"]]);
        expect(await openGuestWatch("t", "1.2.3.4", Date.now(), YARD)).toEqual({
            ok: false,
            error: "private"
        });
    });

    it("serves no picture once it goes private, and says so", async () => {
        reach = live();
        paid = live();
        const opened = await openGuestWatch("t", "1.2.3.4");
        const watch = opened.ok ? opened.watch : "";
        expect(await guestWatchCamera("t", watch)).not.toBeNull();
        yardPrivate = true;
        expect(await guestWatchCamera("t", watch)).toBeNull();
        expect(await guestWatchState("t", watch)).toEqual({ state: "private" });
        paid = null;
        expect(await guestWatchState("t", watch)).toEqual({ state: "gone" });
    });

    it("cuts a stream already playing when privacy turns on", async () => {
        reach = live();
        paid = live();
        const opened = await openGuestWatch("t", "1.2.3.4");
        const watch = opened.ok ? opened.watch : "";
        vi.useFakeTimers();
        const upstream = new ReadableStream<Uint8Array>({
            pull: (controller) => controller.enqueue(new Uint8Array([1]))
        });
        const reader = whileLinkHolds(new Response(upstream), "t", watch).body!.getReader();
        expect((await reader.read()).done).toBe(false);
        yardPrivate = true;
        await vi.advanceTimersByTimeAsync(RECHECK_MS + 1);
        let done = false;
        for (let i = 0; i < 50 && !done; i += 1) done = (await reader.read()).done;
        expect(done).toBe(true);
        vi.useRealTimers();
    });
});
