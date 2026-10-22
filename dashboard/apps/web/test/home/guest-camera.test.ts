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

vi.mock("@polaris/app-host", () => ({
    host: {
        accessGrants: {
            linkReach: async () => reach,
            linkReachPaid: async () => paid,
            spendGrant
        },
        rateLimitService: { rateLimit: async () => limited },
        auditService: { recordAudit }
    }
}));
vi.mock("@polaris-app/places/src/lib/access", () => ({
    homeInstall: async () => ({ id: "install-1" })
}));
vi.mock("@polaris-app/places/src/lib/cameras", () => ({
    getCamera: async (_install: string, id: string) =>
        id === YARD ? { id: YARD, name: "Yard", address: "rtsp://10.0.0.9/live" } : null
}));

const {
    forgetWatches,
    guestCamera,
    guestWatchCamera,
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
