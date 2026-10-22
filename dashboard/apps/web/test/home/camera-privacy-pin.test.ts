/**
 * The certificate a Tapo camera answered with first, and what lets it go: a
 * camera given a new address, or one its owner says to trust again after it
 * was replaced or reset. And a camera made public again is published warm, as
 * it was before it went private.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCameraInput } from "@polaris-app/places/src/lib/schemas";
import { DEFAULT_DETECTION } from "@polaris-app/places/src/lib/detection";

const INSTALL = "install";
const CAM = "0192f2a4-6c1e-7c3a-9a40-aaaaaaaaaaaa";

let existing: Record<string, unknown> = {};
let written: Record<string, unknown> = {};
const cleared = vi.fn();
const published = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        camera: {
            findFirst: async () => existing,
            update: async (args: { data: Record<string, unknown> }) => {
                written = args.data;
                return {
                    ...existing,
                    ...args.data,
                    detectionConfig: JSON.stringify(DEFAULT_DETECTION),
                    retentionDays: 7,
                    lastSeenAt: null,
                    offlineSince: null
                };
            },
            updateMany: async (args: unknown) => {
                cleared(args);
                return { count: 1 };
            }
        },
        cameraEvent: { updateMany: async () => ({ count: 0 }) }
    }
}));

vi.mock("@polaris-app/places/src/lib/relay", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@polaris-app/places/src/lib/relay")>()),
    relayEndpoint: async () => ({ url: "http://relay" }),
    publishCamera: async (...args: unknown[]) => {
        published(...args);
    },
    unpublishCamera: async () => undefined
}));

vi.mock("@polaris-app/places/src/lib/cameras", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@polaris-app/places/src/lib/cameras")>()),
    cameraTarget: async () => ({ id: CAM })
}));

const cameras = await import("@polaris-app/places/src/lib/cameras");
const privacy = await import("@polaris-app/places/src/lib/privacy");

const row = {
    id: CAM,
    name: "Hall",
    placeId: null,
    zone: null,
    vendor: "reolink",
    modelId: null,
    address: "10.0.1.64",
    rtspPort: 554,
    onvifPort: null,
    mainPath: null,
    subPath: null,
    username: null,
    encryptedSecret: null,
    reachVia: "direct",
    detector: "none",
    detectorTargetId: null,
    recording: "off",
    storageTarget: null,
    power: "mains",
    enabled: true,
    privacy: true,
    privacyPreset: null,
    controlPin: "pinned"
};

const input = (address: string) =>
    parseCameraInput({
        name: "Hall",
        vendor: "reolink",
        power: "mains",
        address,
        detection: DEFAULT_DETECTION
    });

beforeEach(() => {
    existing = { ...row };
    written = {};
    cleared.mockClear();
    published.mockClear();
});

describe("the certificate a camera is held to", () => {
    it("is let go when the camera is given a new address", async () => {
        await cameras.updateCamera(INSTALL, CAM, input("10.0.1.65"));
        expect(written.controlPin).toBeNull();
    });

    it("is kept when the address stays the same", async () => {
        await cameras.updateCamera(INSTALL, CAM, input("10.0.1.64"));
        expect("controlPin" in written).toBe(false);
    });

    it("is let go for the cameras named, in this house only", async () => {
        await privacy.trustCamerasAgain(INSTALL, [CAM]);
        expect(cleared).toHaveBeenCalledWith({
            where: { installedAppId: INSTALL, id: { in: [CAM] } },
            data: { controlPin: null }
        });
    });
});

describe("a camera made public again", () => {
    it("is published warm when it runs on mains", async () => {
        const answer = await privacy.cameraPrivacy(INSTALL, CAM, false);
        expect(answer.private).toBe(false);
        expect(published).toHaveBeenCalledTimes(1);
        expect(published.mock.calls[0]?.[3]).toEqual({ warm: true });
    });
});
