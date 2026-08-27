/**
 * One pass over the cameras, and the three ways it could cry wolf.
 *
 * The pass reports silence, so everything that is not silence has to be kept out
 * of it or the alert stops being worth reading. A camera nothing has ever
 * reached is not silent, it is unstarted. A place that went dark all at once is
 * one thing that happened, not four. And an outage that was reported has to be
 * closable, or the log fills with outages that never ended.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface CameraRow {
    id: string;
    name: string;
    placeId: string | null;
    installedAppId: string;
    reachVia: string;
    offlineSince: Date | null;
}

let cameras: CameraRow[] = [];
let events: { id: string; cameraId: string; endedAt: Date | null }[] = [];
/** Which streams the relay says it holds, or null for a relay that would not
 *  answer the question at all. */
let serving: string[] | null = [];
/** Which cameras would answer with a frame. */
let answering = new Set<string>();
let alertRules: Record<string, unknown>[] = [];

const cameraUpdates = vi.fn(
    async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = cameras.find((camera) => camera.id === args.where.id);
        if (row && "offlineSince" in args.data)
            row.offlineSince = args.data.offlineSince as Date | null;
        return row;
    }
);
const eventCreates = vi.fn();
const eventUpdates = vi.fn();
const notify = vi.fn(async () => undefined);
const messages = vi.fn(async () => ({ id: "message" }));

vi.mock("@polaris/db", () => ({
    prisma: {
        camera: {
            findMany: async () => cameras.map((camera) => ({ ...camera })),
            update: (args: never) => cameraUpdates(args as never)
        },
        cameraEvent: {
            findFirst: async (args: { where: Record<string, unknown> }) => {
                const where = args.where as { cameraId: string; endedAt?: null };
                return (
                    events.find(
                        (event) =>
                            event.cameraId === where.cameraId &&
                            (where.endedAt === null ? event.endedAt === null : true)
                    ) ?? null
                );
            },
            create: async (args: { data: { cameraId: string } }) => {
                eventCreates(args.data);
                const event = {
                    id: `event-${events.length}`,
                    cameraId: args.data.cameraId,
                    endedAt: null
                };
                events.push(event);
                return event;
            },
            update: async (args: { where: { id: string }; data: { endedAt: Date } }) => {
                eventUpdates(args);
                const event = events.find((row) => row.id === args.where.id);
                if (event) event.endedAt = args.data.endedAt;
                return event;
            }
        },
        place: {
            findMany: async () => [{ id: "place", name: "Home" }],
            findFirst: async () => ({ name: "Home" })
        },
        installedApp: { findFirst: async () => ({ ownerId: "owner" }) },
        alertRule: {
            findMany: async () => alertRules,
            update: async () => undefined
        },
        chatMessage: { create: (args: never) => messages(args as never) },
        chatChannel: { update: async () => undefined },
        chatChannelMember: { findMany: async () => [] }
    }
}));

vi.mock("@/lib/home/relay", () => ({
    relayServerFor: (reachVia: string) =>
        reachVia.startsWith("server:") ? reachVia.slice("server:".length) : "local",
    streamName: (cameraId: string, quality: string) => `${cameraId}-${quality}`,
    relayEndpoint: async () => ({ baseUrl: "http://relay", installedAppId: "install" }),
    publishedStreams: async () => serving,
    snapshot: async (_endpoint: unknown, cameraId: string) =>
        answering.has(cameraId) ? Buffer.from([1]) : null
}));

vi.mock("@/lib/notifications/dispatch", () => ({ notify }));
vi.mock("@/lib/notifications/preferences", () => ({
    ruleFor: async () => ({ inapp: true, email: false, destinations: [] })
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));

const { sweepCameraReachability } = await import("@/lib/home/reachability");
const { OFFLINE_GRACE_MS } = await import("@/lib/home/availability");

/** A camera that has already been quiet for longer than the grace window, so
 *  this pass is the one that would report it. */
function quiet(id: string, name: string): CameraRow {
    return {
        id,
        name,
        placeId: "place",
        installedAppId: "install",
        reachVia: "local",
        offlineSince: new Date(Date.now() - OFFLINE_GRACE_MS - 60_000)
    };
}

beforeEach(() => {
    cameras = [];
    events = [];
    serving = [];
    answering = new Set();
    alertRules = [];
    vi.clearAllMocks();
});

describe("a camera nothing has ever reached", () => {
    it("is left out rather than reported as having stopped", async () => {
        // Saved with the wrong password: it was never started, so the relay
        // holds no stream for it and answers exactly as it would for a camera
        // that had gone dark. Telling somebody it "stopped answering" would be
        // reporting an outage on a picture they have never seen.
        cameras = [
            {
                id: "new",
                name: "Front door",
                placeId: "place",
                installedAppId: "install",
                reachVia: "local",
                offlineSince: null
            }
        ];
        serving = [];

        const sweep = await sweepCameraReachability();

        expect(sweep.probed).toBe(0);
        expect(sweep.reported).toBe(0);
        expect(cameraUpdates).not.toHaveBeenCalled();
        expect(eventCreates).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });

    it("is still reported once the relay has been given it", async () => {
        cameras = [quiet("cam", "Front door")];
        serving = ["cam-main", "cam-sub"];

        const sweep = await sweepCameraReachability();

        expect(sweep.reported).toBe(1);
        expect(eventCreates).toHaveBeenCalledTimes(1);
    });
});

describe("a relay that will not say what it is serving", () => {
    it("does not silence the cameras behind it", async () => {
        // A relay that is down holds no streams as far as the question can see,
        // and treating that as "nothing was ever published" would go quiet at
        // the one moment every camera on it became unwatchable.
        cameras = [quiet("cam", "Front door")];
        serving = null;

        const sweep = await sweepCameraReachability();

        expect(sweep.probed).toBe(1);
        expect(sweep.reported).toBe(1);
    });
});

describe("a place that went dark all at once", () => {
    beforeEach(() => {
        cameras = [
            quiet("a", "Front door"),
            quiet("b", "Garden"),
            quiet("c", "Hallway"),
            quiet("d", "Garage")
        ];
        serving = cameras.flatMap((camera) => [`${camera.id}-main`, `${camera.id}-sub`]);
    });

    it("writes what happened to every camera and says it once", async () => {
        const sweep = await sweepCameraReachability();

        expect(sweep.reported).toBe(4);
        // The log is per camera: four of them stopped, and each row is the
        // record of one of them.
        expect(eventCreates).toHaveBeenCalledTimes(4);
        // The bell is not. All four carry the same sentence, and four copies of
        // it is the alert fatigue the grace window exists to prevent.
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0]?.[0]).toMatchObject({
            title: "Every camera at Home stopped answering"
        });
    });

    it("posts one line into the conversation a rule watches", async () => {
        alertRules = [
            {
                id: "rule",
                name: "The house went quiet",
                placeId: null,
                cameraId: null,
                kinds: JSON.stringify(["offline"]),
                label: null,
                zones: JSON.stringify([]),
                hours: null,
                recipients: JSON.stringify(["owner"]),
                notify: false,
                enabled: true,
                channelId: "channel"
            }
        ];

        await sweepCameraReachability();

        expect(messages).toHaveBeenCalledTimes(1);
    });
});

describe("a camera that comes back", () => {
    beforeEach(() => {
        cameras = [quiet("cam", "Front door")];
        serving = ["cam-main", "cam-sub"];
        answering = new Set(["cam"]);
        events = [{ id: "open", cameraId: "cam", endedAt: null }];
    });

    it("closes the outage and says how long it was", async () => {
        const sweep = await sweepCameraReachability();

        expect(sweep.recovered).toBe(1);
        expect(eventUpdates).toHaveBeenCalledTimes(1);
        expect(cameras[0]?.offlineSince).toBeNull();
    });

    it("keeps the outage retryable when telling somebody fails", async () => {
        // The other order loses it for good: the column is cleared, the next
        // pass sees a camera that was never down, and the row keeps `endedAt:
        // null` forever - an outage that reads as still in progress on a camera
        // that came back hours ago.
        notify.mockRejectedValueOnce(new Error("the bell is not writable"));

        await sweepCameraReachability();

        expect(cameras[0]?.offlineSince).not.toBeNull();
    });
});
