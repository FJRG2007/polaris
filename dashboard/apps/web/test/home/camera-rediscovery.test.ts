/**
 * A camera the network handed another address is found again by its hardware
 * address instead of being reported as gone.
 *
 * The pass records the MAC of every camera that answers (which is how cameras
 * added before the column get one), and when a camera with a MAC stops
 * answering, it is looked up by that MAC, moved, given to the relay again and
 * asked once more. A camera on another server's network, or one stored by name,
 * is left alone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface CameraRow {
    id: string;
    name: string;
    placeId: string | null;
    installedAppId: string;
    reachVia: string;
    offlineSince: Date | null;
    address: string;
    hardwareAddress: string | null;
    vendor: string;
    power: string;
    enabled: boolean;
    privacy: boolean;
}

let cameras: CameraRow[] = [];
/** Addresses at which a camera answers with a frame, keyed by camera id. */
let answeringAt = new Map<string, string>();
/** The neighbour table: IP -> MAC. */
let neighbours = new Map<string, string>();

const updates = vi.fn(async (args: { where: { id: string }; data: Partial<CameraRow> }) => {
    const row = cameras.find((camera) => camera.id === args.where.id);
    if (row) Object.assign(row, args.data);
    return row;
});
const published = vi.fn();
const located = vi.fn();
const talkEnded = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        camera: {
            findMany: async () => cameras.map((camera) => ({ ...camera })),
            update: (args: never) => updates(args as never)
        },
        cameraEvent: {
            findFirst: async () => null,
            create: async () => ({ id: "e" }),
            update: async () => undefined
        },
        place: {
            findMany: async () => [{ id: "place", name: "Home" }],
            findFirst: async () => ({ name: "Home" })
        },
        installedApp: { findFirst: async () => ({ ownerId: "owner" }) },
        alertRule: { findMany: async () => [], update: async () => undefined },
        chatMessage: { create: async () => ({ id: "m" }) },
        chatChannel: { update: async () => undefined },
        chatChannelMember: { findMany: async () => [] }
    }
}));

vi.mock("@polaris-app/places/src/lib/relay", () => ({
    relayServerFor: (reachVia: string) =>
        reachVia.startsWith("server:") ? reachVia.slice("server:".length) : "local",
    streamName: (cameraId: string, quality: string) => `${cameraId}-${quality}`,
    relayEndpoint: async () => ({ baseUrl: "http://relay", installedAppId: "install" }),
    publishedStreams: async () => null,
    keepsWarm: () => true,
    publishCamera: async (_endpoint: unknown, target: { id: string; address: string }) =>
        published(target.id, target.address),
    snapshot: async (_endpoint: unknown, cameraId: string) => {
        const row = cameras.find((camera) => camera.id === cameraId);
        return row && answeringAt.get(cameraId) === row.address ? Buffer.from([1]) : null;
    }
}));

vi.mock("@polaris-app/places/src/lib/integrations/mac-locate", () => ({
    macsAt: async (addresses: readonly string[]) =>
        new Map(
            addresses.flatMap((address) =>
                neighbours.has(address) ? [[address, neighbours.get(address)!]] : []
            )
        ),
    locateMac: async (mac: string, options: { avoid?: string }) => {
        located(mac, options.avoid);
        for (const [address, hardware] of neighbours) if (hardware === mac) return address;
        return null;
    }
}));

vi.mock("@polaris-app/places/src/lib/cameras", () => ({
    cameraTarget: async (_install: string, id: string) => {
        const row = cameras.find((camera) => camera.id === id);
        return row ? { id: row.id, address: row.address } : null;
    }
}));

vi.mock("@polaris-app/places/src/lib/talk", () => ({
    endCameraTalk: async (id: string) => talkEnded(id)
}));

vi.mock("@/lib/notifications/dispatch", () => ({ notify: async () => undefined }));
vi.mock("@/lib/notifications/preferences", () => ({
    ruleFor: async () => ({ inapp: true, email: false, destinations: [] })
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));

const { sweepCameraReachability } = await import("@polaris-app/places/src/lib/reachability");

const MAC = "AA:BB:CC:00:11:22";

function camera(overrides: Partial<CameraRow> = {}): CameraRow {
    return {
        id: "door",
        name: "Door",
        placeId: "place",
        installedAppId: "install",
        reachVia: "direct",
        offlineSince: null,
        address: "192.168.1.20",
        hardwareAddress: null,
        vendor: "tapo",
        power: "mains",
        enabled: true,
        privacy: false,
        ...overrides
    };
}

beforeEach(() => {
    cameras = [];
    answeringAt = new Map();
    neighbours = new Map();
    updates.mockClear();
    published.mockClear();
    located.mockClear();
    talkEnded.mockClear();
});

describe("camera rediscovery by hardware address", () => {
    it("records the MAC of a camera that answers and has none (retroactive)", async () => {
        cameras = [camera()];
        answeringAt.set("door", "192.168.1.20");
        neighbours.set("192.168.1.20", MAC);
        await sweepCameraReachability();
        expect(cameras[0]!.hardwareAddress).toBe(MAC);
    });

    it("does not rewrite a MAC that still answers at the stored address", async () => {
        cameras = [camera({ hardwareAddress: MAC })];
        answeringAt.set("door", "192.168.1.20");
        neighbours.set("192.168.1.20", MAC);
        await sweepCameraReachability();
        expect(cameras[0]!.hardwareAddress).toBe(MAC);
        expect(updates.mock.calls.some(([args]) => "hardwareAddress" in args.data)).toBe(false);
    });

    it("takes the MAC of a different unit now answering at the stored address", async () => {
        cameras = [camera({ hardwareAddress: MAC })];
        answeringAt.set("door", "192.168.1.20");
        neighbours.set("192.168.1.20", "FF:FF:FF:FF:FF:FF");
        await sweepCameraReachability();
        expect(cameras[0]!.hardwareAddress).toBe("FF:FF:FF:FF:FF:FF");
        expect(talkEnded).not.toHaveBeenCalled();
    });

    it("moves a quiet camera to where its MAC answers now and keeps it up", async () => {
        cameras = [camera({ hardwareAddress: MAC })];
        answeringAt.set("door", "10.0.0.7");
        neighbours.set("10.0.0.7", MAC);
        const sweep = await sweepCameraReachability();
        expect(cameras[0]!.address).toBe("10.0.0.7");
        expect(located).toHaveBeenCalledWith(MAC, "192.168.1.20");
        expect(published).toHaveBeenCalledWith("door", "10.0.0.7");
        expect(talkEnded).toHaveBeenCalledWith("door");
        expect(cameras[0]!.offlineSince).toBeNull();
        expect(sweep.probed).toBe(1);
    });

    it("starts the outage clock when the MAC is nowhere", async () => {
        cameras = [camera({ hardwareAddress: MAC })];
        await sweepCameraReachability();
        expect(cameras[0]!.address).toBe("192.168.1.20");
        expect(published).not.toHaveBeenCalled();
        expect(cameras[0]!.offlineSince).toBeInstanceOf(Date);
    });

    it("leaves a camera behind another server or stored by name alone", async () => {
        cameras = [
            camera({ id: "far", reachVia: "server:host-2", hardwareAddress: MAC }),
            camera({ id: "named", address: "door-cam.local", hardwareAddress: MAC })
        ];
        neighbours.set("10.0.0.7", MAC);
        await sweepCameraReachability();
        expect(located).not.toHaveBeenCalled();
        expect(cameras.map((row) => row.address)).toEqual(["192.168.1.20", "door-cam.local"]);
    });
});
