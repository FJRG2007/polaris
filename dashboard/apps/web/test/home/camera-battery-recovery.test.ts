/**
 * The outage a battery camera would otherwise carry for good.
 *
 * The availability pass is the only thing that clears `offlineSince` and closes
 * the open row in the log, and it does not dial a battery camera at all - asleep
 * is not an outage for one, and a wake-up a minute is the whole charge. So the
 * moment a camera that was already down is moved onto a battery make, nothing is
 * ever going to come back and settle it: the wall and the cameras list would
 * read "not answering since" a date that can never advance, and the event in the
 * log would stay open on an outage that has no end.
 *
 * That state is reachable by exactly the route the feature invites - a C410
 * added as a wired Tapo, never streaming, reported down, then corrected to the
 * battery profile - so settling it is part of the correction.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DETECTION } from "@/lib/home/detection";
import { parseCameraInput } from "@/lib/home/schemas";

/** The row as the update leaves it, so the test can read what was written. */
let stored: Record<string, unknown> = {};
const closed = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        camera: {
            findFirst: async () => ({ id: "cam-1" }),
            update: async (args: { data: Record<string, unknown> }) => {
                stored = args.data;
                return {
                    id: "cam-1",
                    name: "Garden",
                    placeId: null,
                    zone: null,
                    vendor: args.data.vendor,
                    model: null,
                    address: args.data.address,
                    rtspPort: 554,
                    onvifPort: args.data.onvifPort ?? null,
                    mainPath: null,
                    subPath: null,
                    username: null,
                    encryptedSecret: null,
                    reachVia: "direct",
                    detector: args.data.detector,
                    detectorTargetId: null,
                    detectionConfig: JSON.stringify(DEFAULT_DETECTION),
                    recording: args.data.recording,
                    storageTarget: null,
                    retentionDays: 7,
                    enabled: true,
                    lastSeenAt: null,
                    offlineSince: "offlineSince" in args.data ? args.data.offlineSince : new Date()
                };
            }
        },
        cameraEvent: {
            updateMany: async (args: unknown) => {
                closed(args);
                return { count: 1 };
            }
        }
    }
}));

const cameras = await import("../../src/lib/home/cameras");

const input = (vendor: string) =>
    parseCameraInput({
        name: "Garden",
        vendor,
        address: "192.168.1.64",
        detection: DEFAULT_DETECTION
    });

beforeEach(() => {
    stored = {};
    closed.mockClear();
});

describe("a camera moved onto a make nothing dials", () => {
    it("stops carrying the clock the availability pass will never clear", async () => {
        const view = await cameras.updateCamera("install", "cam-1", input("tapo-battery"));

        expect(stored.offlineSince).toBeNull();
        expect(view.offlineSince).toBeNull();
    });

    it("closes the outage that was left open on it", async () => {
        await cameras.updateCamera("install", "cam-1", input("tapo-battery"));

        expect(closed).toHaveBeenCalledTimes(1);
        const [args] = closed.mock.calls[0] as [
            { where: Record<string, unknown>; data: { endedAt: Date } }
        ];
        expect(args.where).toMatchObject({ cameraId: "cam-1", kind: "offline", endedAt: null });
        expect(args.data.endedAt).toBeInstanceOf(Date);
    });

    it("leaves a wired camera's outage exactly where it was", async () => {
        await cameras.updateCamera("install", "cam-1", input("tapo-cloud"));

        expect("offlineSince" in stored).toBe(false);
        expect(closed).not.toHaveBeenCalled();
    });
});
