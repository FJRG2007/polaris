/**
 * The address a vision worker is handed, which has now been wrong twice.
 *
 * Polaris reaches its own containers by going out to the host and back in, by a
 * name its compose file gives it - `host.docker.internal`. A container Polaris
 * deployed was never given that name, so an address built that way resolves to
 * nothing from inside one. The worker's ffmpeg exits the instant it starts, the
 * supervisor opens it again thirty seconds later, and the error goes to a stderr
 * nothing reads: what an operator sees is a camera that has noticed nothing
 * since the day it was added, and a log repeating that it is watching it.
 *
 * The first fix corrected the recognizer's address and left the camera stream's
 * alone, which is the failure this file exists for. One missed call site is
 * indistinguishable from no fix at all, because the stream is the one that has
 * to work before anything else runs.
 *
 * So both are asserted, from one built assignment, rather than the helper being
 * tested on its own - a helper that is right and called in one of two places is
 * exactly what shipped.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const RELAY = {
    installedAppId: "relay-install",
    baseUrl: "http://127.0.0.1:35589",
    directUrl: "http://host.docker.internal:35589",
    networkUrl: "http://marketplace-camera-relay-d925:1984",
    username: "polaris",
    password: "secret"
};

const FACES = {
    baseUrl: "http://127.0.0.1:35590",
    directUrl: "http://host.docker.internal:35590",
    networkUrl: "http://marketplace-face-recognition-bb96:8000",
    apiKey: "face-key"
};

/** What the two lookups answer with, so a test can take one away. */
let relay: typeof RELAY | null = RELAY;
let faces: typeof FACES | null = FACES;

const CAMERA = {
    id: "01a00d93-d87f-70b0-820a-5f8a819448ce",
    name: "Studio Camera",
    detector: "faces",
    detectionConfig: null,
    reachVia: "local"
};

vi.mock("@polaris/db", () => ({
    prisma: { camera: { findMany: vi.fn(async () => [CAMERA]) } }
}));
vi.mock("@/lib/home/relay", () => ({
    relayEndpoint: vi.fn(async () => relay),
    relayServerFor: (value: string) => value,
    streamName: (id: string, quality: string) => `${id}-${quality}`
}));
vi.mock("@/lib/home/recognizer", () => ({ recognizerFor: vi.fn(async () => faces) }));
vi.mock("@/lib/home/camera-zones", () => ({ zonesByCamera: vi.fn(async () => new Map()) }));
vi.mock("@/lib/apps/install-service", () => ({ installApp: vi.fn() }));
vi.mock("@/lib/apps/install-secret", () => ({ installEnvSecret: vi.fn() }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: vi.fn(async () => "https://polaris.example") }));
vi.mock("@/lib/home/side-service", () => ({
    assertServer: vi.fn(),
    findService: vi.fn(async () => null)
}));

const { assignmentsFor } = await import("@/lib/home/vision");

beforeEach(() => {
    relay = RELAY;
    faces = FACES;
});

describe("what a worker is told to dial", () => {
    it("reads the camera over the network the two containers share", async () => {
        const [assignment] = await assignmentsFor("install-1");
        expect(assignment?.streamUrl).toContain("marketplace-camera-relay-d925:1984");
        // The one that has to be true. An address that leaves the container is
        // an ffmpeg that exits before it reads a frame.
        expect(assignment?.streamUrl).not.toContain("host.docker.internal");
    });

    it("asks who somebody is over that same network", async () => {
        const [assignment] = await assignmentsFor("install-1");
        expect(assignment?.faces?.baseUrl).toBe("http://marketplace-face-recognition-bb96:8000");
        expect(assignment?.faces?.baseUrl).not.toContain("host.docker.internal");
    });

    it("still names the stream and carries the relay's credentials", async () => {
        const [assignment] = await assignmentsFor("install-1");
        // The small stream, never the good one: this is a detector, not a viewer.
        expect(assignment?.streamUrl).toContain(`src=${CAMERA.id}-sub`);
        expect(assignment?.authorization).toBe(
            `Basic ${Buffer.from("polaris:secret").toString("base64")}`
        );
    });

    it("falls back to the direct address when there is no shared network", async () => {
        // A relay on another machine has no container name that means anything
        // here, and the direct address is the only one there is.
        relay = { ...RELAY, networkUrl: null };
        faces = { ...FACES, networkUrl: null };
        const [assignment] = await assignmentsFor("install-1");
        expect(assignment?.streamUrl).toContain("host.docker.internal:35589");
        expect(assignment?.faces?.baseUrl).toBe("http://host.docker.internal:35590");
    });

    it("gives out no assignment at all for a camera whose relay is not up", async () => {
        // Better than one the worker can only fail to connect to, on a loop.
        relay = null;
        expect(await assignmentsFor("install-1")).toEqual([]);
    });
});
