/**
 * A wall panel's link watches the cameras on the panel and nothing else, and
 * only when it was lent with `watch`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PANEL = "00000000-0000-4000-8000-0000000000e1";
const PORCH = "00000000-0000-4000-8000-0000000000c1";
const BARN = "00000000-0000-4000-8000-0000000000c2";

let reach: unknown = null;
const panelHoldsCamera = vi.fn(async (_i: string, _p: string, id: string) => id === PORCH);

vi.mock("@polaris/app-host", () => ({
    host: {
        accessGrants: {
            linkReach: async () => reach,
            linkReachPaid: async () => reach,
            recordGrantUse: async () => undefined,
            spendGrant: async () => true
        },
        rateLimitService: { rateLimit: async () => ({ ok: true, retryAfterMs: 0 }) },
        auditService: { recordAudit: async () => undefined }
    }
}));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris-app/places/src/lib/access", () => ({
    homeInstall: async () => ({ id: "install-1" })
}));
vi.mock("@polaris-app/places/src/lib/panels", () => ({ panelHoldsCamera }));
vi.mock("@polaris-app/places/src/lib/sharing", () => ({
    isThingId: (id: string) => /^[0-9a-f-]{36}$/.test(id),
    roomContents: async () => ({ devices: new Map(), cameras: new Map() })
}));
vi.mock("@polaris-app/places/src/lib/cameras", () => ({
    getCamera: async (_i: string, id: string) => ({ id, name: "x", privacy: false })
}));

const { forgetWatches, guestWatchCamera, openGuestWatch } = await import(
    "@polaris-app/places/src/lib/guest-camera"
);

function live(actions: string[], subjectType = "place.panel") {
    return {
        standing: "live",
        subjectType,
        subjectId: PANEL,
        note: "",
        grant: { id: "g1", capability: "control", actions, until: null, counted: false }
    };
}

beforeEach(() => {
    forgetWatches();
    vi.clearAllMocks();
});

describe("a wall panel link's cameras", () => {
    it("opens a camera on the panel, and its pictures follow", async () => {
        reach = live(["watch"]);
        const opened = await openGuestWatch("t", "1.2.3.4", Date.now(), PORCH);
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        expect(await guestWatchCamera("t", opened.watch)).toEqual({
            installId: "install-1",
            cameraId: PORCH
        });
    });

    it("refuses a camera that is not on the panel", async () => {
        reach = live(["watch"]);
        expect(await openGuestWatch("t", "1.2.3.4", Date.now(), BARN)).toEqual({
            ok: false,
            error: "closed"
        });
    });

    it("refuses every camera to a panel link lent without watch", async () => {
        reach = live(["operate"]);
        expect(await openGuestWatch("t", "1.2.3.4", Date.now(), PORCH)).toEqual({
            ok: false,
            error: "closed"
        });
        expect(panelHoldsCamera).not.toHaveBeenCalled();
    });

    it("stops a playing picture once the camera is taken off the panel", async () => {
        reach = live(["watch"]);
        const opened = await openGuestWatch("t", "1.2.3.4", Date.now(), PORCH);
        if (!opened.ok) throw new Error("not opened");
        panelHoldsCamera.mockResolvedValueOnce(false);
        expect(await guestWatchCamera("t", opened.watch)).toBeNull();
    });
});
