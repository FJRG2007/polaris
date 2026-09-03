/**
 * The outage a battery camera would otherwise carry for good.
 *
 * The availability pass is the only thing that clears `offlineSince` and closes
 * the open row in the log, and it does not dial a camera running off its own
 * charge at all - asleep is not an outage for one, and a wake-up a minute is the
 * whole battery. So the moment a camera that was already down is told it is on a
 * battery, nothing is ever going to come back and settle it: the wall and the
 * cameras list would read "not answering since" a date that can never advance,
 * and the event in the log would stay open on an outage that has no end.
 *
 * That state is reachable by exactly the route the feature invites - a C410
 * added as a wired camera, never streaming, reported down, then corrected - so
 * settling it is part of the correction.
 *
 * What decides it is how the camera is powered rather than which make it is: the
 * same model on a cable is dialled like any other camera, and its outage is the
 * pass's to clear rather than this function's to erase.
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

const input = (power: string, modelId = "tapo-c410") =>
    parseCameraInput({
        name: "Garden",
        vendor: "tapo-battery",
        modelId,
        power,
        address: "192.168.1.64",
        detection: DEFAULT_DETECTION
    });

beforeEach(() => {
    stored = {};
    closed.mockClear();
});

describe("a camera told it is running off its own charge", () => {
    it("stops carrying the clock the availability pass will never clear", async () => {
        const view = await cameras.updateCamera("install", "cam-1", input("battery"));

        expect(stored.offlineSince).toBeNull();
        expect(view.offlineSince).toBeNull();
    });

    it("closes the outage that was left open on it", async () => {
        await cameras.updateCamera("install", "cam-1", input("battery"));

        expect(closed).toHaveBeenCalledTimes(1);
        const [args] = closed.mock.calls[0] as [
            { where: Record<string, unknown>; data: { endedAt: Date } }
        ];
        expect(args.where).toMatchObject({ cameraId: "cam-1", kind: "offline", endedAt: null });
        expect(args.data.endedAt).toBeInstanceOf(Date);
    });

    it("does the same for one on a battery and a panel", async () => {
        // A panel replaces what a day costs, not what a permanent connection
        // costs, so the pass leaves that one alone too.
        await cameras.updateCamera("install", "cam-1", input("battery-solar"));

        expect(stored.offlineSince).toBeNull();
        expect(closed).toHaveBeenCalledTimes(1);
    });

    it("leaves the same model's outage alone once it is plugged in", async () => {
        // The make is identical and the answer is opposite: a C410 on a cable is
        // dialled like any other camera, so its outage is real and the pass is
        // what should clear it.
        await cameras.updateCamera("install", "cam-1", input("mains"));

        expect("offlineSince" in stored).toBe(false);
        expect(closed).not.toHaveBeenCalled();
    });
});
