/**
 * Switching a camera from the wall or the list, on the server.
 *
 * The switch is gated on running the house, only reaches a camera of this
 * install, and takes the relay with it: off drops the camera from the relay, on
 * hands it back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const INSTALL = "install-1";
const OWNER = "owner-1";
const USER = "user-1";

type Row = Record<string, unknown>;
const rows = new Map<string, Row>();

function row(id: string, installedAppId: string, overrides: Row = {}): Row {
    return {
        id,
        installedAppId,
        name: "Front door",
        placeId: "place",
        zone: "Porch",
        roomId: null,
        vendor: "generic",
        model: null,
        modelId: null,
        power: "mains",
        address: "192.0.2.1",
        rtspPort: 554,
        onvifPort: null,
        mainPath: "",
        subPath: "",
        username: "",
        encryptedSecret: null,
        secretNonce: null,
        secretKeyId: null,
        reachVia: "local",
        detector: "none",
        detectorTargetId: null,
        detectionConfig: null,
        recording: "off",
        storageTarget: null,
        retentionDays: 30,
        enabled: true,
        lastSeenAt: null,
        offlineSince: null,
        privacy: false,
        privacyPreset: null,
        ...overrides
    };
}

function matches(candidate: Row, where: Row): boolean {
    return Object.entries(where).every(([key, value]) => candidate[key] === value);
}

const update = vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
    const current = rows.get(where.id);
    if (!current) throw new Error("no such row");
    const next = { ...current, ...data };
    rows.set(where.id, next);
    return next;
});

vi.mock("@polaris/db", () => ({
    prisma: {
        camera: {
            findFirst: async ({ where }: { where: Row }) =>
                [...rows.values()].find((candidate) => matches(candidate, where)) ?? null,
            update: (args: { where: { id: string }; data: Row }) => update(args)
        }
    }
}));

const requireHome = vi.fn(async (_permission: string) => ({
    user: { id: USER },
    install: { id: INSTALL, ownerId: OWNER }
}));

vi.mock("@polaris-app/places/src/lib/access", () => ({
    requireHome: (permission: string) => requireHome(permission),
    requireHomeInstall: vi.fn(),
    requireHomeShared: vi.fn()
}));

const endpoint = { url: "http://relay.test" };
const relayEndpoint = vi.fn(async (_server: string) => endpoint);
const unpublishCamera = vi.fn(async (_endpoint: unknown, _id: string) => undefined);
const ensureRelay = vi.fn(async (..._args: unknown[]) => endpoint);
const publishCamera = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock("@polaris-app/places/src/lib/relay", async (original) => ({
    ...(await original<typeof import("@polaris-app/places/src/lib/relay")>()),
    relayEndpoint: (server: string) => relayEndpoint(server),
    unpublishCamera: (target: unknown, id: string) => unpublishCamera(target, id),
    ensureRelay: (...args: unknown[]) => ensureRelay(...args),
    publishCamera: (...args: unknown[]) => publishCamera(...args)
}));

vi.mock("@polaris-app/places/src/lib/i18n", async (original) => {
    const real = await original<typeof import("@polaris-app/places/src/lib/i18n")>();
    return { ...real, placesT: async () => real.placesTIn("en-US") };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const { switchCameraAction } = await import("@polaris-app/places/src/screens/actions");

async function settled(): Promise<void> {
    for (let step = 0; step < 20; step += 1) await new Promise((done) => setTimeout(done, 0));
}

beforeEach(() => {
    rows.clear();
    rows.set("mine", row("mine", INSTALL));
    rows.set("theirs", row("theirs", "install-2"));
    for (const mock of [
        update,
        requireHome,
        relayEndpoint,
        unpublishCamera,
        ensureRelay,
        publishCamera
    ])
        mock.mockClear();
});

describe("switchCameraAction", () => {
    it("asks for the right to run the house", async () => {
        await switchCameraAction("mine", { recording: "motion" });
        expect(requireHome).toHaveBeenCalledWith("home.manage");
    });

    it("refuses a camera of another install and touches neither it nor the relay", async () => {
        const result = await switchCameraAction("theirs", { enabled: false });
        expect(result.camera).toBeUndefined();
        expect(result.error).toBeTruthy();
        expect(update).not.toHaveBeenCalled();
        expect(rows.get("theirs")!.enabled).toBe(true);
        expect(unpublishCamera).not.toHaveBeenCalled();
    });

    it("refuses anything but the two switches", async () => {
        const result = await switchCameraAction("mine", { enabled: false, name: "x" });
        expect(result.error).toBeTruthy();
        expect(update).not.toHaveBeenCalled();
    });

    it("drops a camera switched off from the relay", async () => {
        const result = await switchCameraAction("mine", { enabled: false });
        expect(result.camera?.enabled).toBe(false);
        expect(rows.get("mine")!.enabled).toBe(false);
        expect(unpublishCamera).toHaveBeenCalledWith(endpoint, "mine");
        await settled();
        expect(publishCamera).not.toHaveBeenCalled();
    });

    it("hands a camera switched back on to the relay", async () => {
        rows.set("mine", row("mine", INSTALL, { enabled: false }));
        const result = await switchCameraAction("mine", { enabled: true });
        expect(result.camera?.enabled).toBe(true);
        expect(unpublishCamera).not.toHaveBeenCalled();
        await settled();
        expect(ensureRelay).toHaveBeenCalled();
        expect(publishCamera).toHaveBeenCalledWith(
            endpoint,
            expect.objectContaining({ id: "mine" }),
            "generic",
            expect.anything()
        );
    });

    it("leaves a camera in privacy off the relay when it is switched back on", async () => {
        rows.set("mine", row("mine", INSTALL, { enabled: false, privacy: true }));
        await switchCameraAction("mine", { enabled: true });
        await settled();
        expect(publishCamera).not.toHaveBeenCalled();
    });

    it("changes what it keeps without touching the relay", async () => {
        const result = await switchCameraAction("mine", { recording: "continuous" });
        expect(result.camera?.recording).toBe("continuous");
        expect(unpublishCamera).not.toHaveBeenCalled();
        await settled();
        expect(publishCamera).not.toHaveBeenCalled();
    });
});
