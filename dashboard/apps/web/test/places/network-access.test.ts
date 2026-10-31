/**
 * Who is told where a thing is on the network, asked of the server.
 *
 * The rule is the same for every kind of thing: whoever may manage it gets its
 * address and hardware address, and a resident, a visitor lent the thing or a
 * stranger gets neither - whatever the screen would have drawn for them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CAMERA_ID = "11111111-1111-4111-8111-111111111111";
const NAS_ID = "33333333-3333-4333-8333-333333333333";
const UPS_ID = "22222222-2222-4222-8222-222222222222";
const ADDRESS = "192.168.1.20";
const MAC = "AA:BB:CC:DD:EE:01";

const session = vi.hoisted(() => ({
    held: new Set<string>(),
    lentCameras: {} as Record<string, string>
}));

const refused = "refused";

vi.mock("@/lib/session", () => ({
    requireUser: async () => ({ id: "u1", isAdmin: false }),
    requirePermission: async (permission: string) => {
        if (!session.held.has(permission)) throw new Error(refused);
        return { id: "u1", isAdmin: false };
    },
    sessionCan: async (_user: unknown, permission: string) => session.held.has(permission),
    sessionCanAny: async (_user: unknown, permission: string) => session.held.has(permission),
    homePathForUser: async () => "/"
}));
vi.mock("@/lib/api-session", () => ({
    apiUser: async () => ({ id: "u1", isAdmin: false })
}));
vi.mock("@/lib/i18n/reader-words", () => ({
    readerWords: async () => (key: string) => key
}));
vi.mock("@/lib/access/grants", () => ({
    liveGrants: async () => [],
    grantedSubjects: async (_userId: string, subject: string) =>
        new Map(subject === "place.camera" ? Object.entries(session.lentCameras) : []),
    grantedActions: async () => new Map(),
    reachesAnySubject: async () => Object.keys(session.lentCameras).length > 0,
    spendGrant: async () => true
}));
vi.mock("@/lib/storage-whereabouts/neighbours", () => ({
    readNeighbourTable: async () => new Map([["192.168.1.20", "aa:bb:cc:dd:ee:01"]])
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: async () => ({ id: "install-1", ownerId: "owner", name: "Home" })
        }
    }
}));

const camera = { id: CAMERA_ID, name: "Yard", placeId: "place", address: ADDRESS };
const otherCamera = { ...camera, id: "other", name: "Hall" };

vi.mock("@polaris-app/places/src/lib/cameras", async (original) => ({
    ...(await original<typeof import("@polaris-app/places/src/lib/cameras")>()),
    listCameras: async () => [camera, otherCamera],
    getCamera: async (_install: string, id: string) => (id === CAMERA_ID ? camera : null)
}));
vi.mock("@polaris-app/places/src/lib/current-place", () => ({
    currentPlace: async () => ({ current: { id: "place" }, places: [] })
}));
vi.mock("@polaris-app/places/src/lib/devices", () => ({
    listDevices: async () => [],
    syncDevices: async () => undefined
}));
vi.mock("@polaris-app/places/src/lib/automations", () => ({ listAutomations: async () => [] }));
vi.mock("@polaris-app/places/src/lib/events", () => ({ listEvents: async () => [] }));
vi.mock("@polaris-app/places/src/lib/device-accounts", async (original) => ({
    ...(await original<typeof import("@polaris-app/places/src/lib/device-accounts")>()),
    listAccounts: async () => [
        {
            id: "lock",
            connection: "nuki-local",
            label: "Front lock",
            settings: { host: ADDRESS }
        }
    ]
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn() }));
vi.mock("@/app/(app)/apps/servers/server-rows", () => ({ listServerRows: async () => [] }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const nasStanding = vi.fn();
vi.mock("@/lib/nas/nas-access", () => ({
    nasStanding: (...args: unknown[]) => nasStanding(...args)
}));
vi.mock("@/lib/nas/nas-service", async (original) => ({
    ...(await original<typeof import("@/lib/nas/nas-service")>()),
    nasRow: async () => ({ id: "nas", ownerId: "owner" }),
    nasNetwork: async () => ({ address: ADDRESS, mac: MAC })
}));

vi.mock("@/lib/ups/ups-service", async (original) => {
    const ups = { id: "22222222-2222-4222-8222-222222222222", host: "192.168.1.20" };
    return {
        ...(await original<typeof import("@/lib/ups/ups-service")>()),
        getUps: async () => ups,
        usbListing: () => async () => [],
        adoptUsb: async () => 0,
        upsSnapshot: async () => [{ ups, result: { ok: false, reason: "unreachable" } }],
        usbOffers: async () => ({ state: "ok", offers: [] }),
        dismissedOffers: async (offers: unknown) => offers
    };
});

vi.mock("@/lib/host-service", () => ({
    listHosts: async () => [{ id: "mine", address: ADDRESS }]
}));
vi.mock("@/lib/host-address", () => ({ getHostLanIp: async () => ADDRESS }));

const home = await import("@polaris-app/places/src/screens/actions");
const overview = await import("@polaris-app/places/src/screens/overview/actions");
const { machineNetworkAction } = await import("@/app/(app)/places/machines/actions");
const { nasNetworkAction } = await import("@/app/(app)/places/nas/actions");
const { upsNetworkAction } = await import("@/app/(app)/places/ups/actions");
const { GET: upsList } = await import("@/app/api/servers/ups/route");

const details = { address: ADDRESS, mac: MAC };

function manager() {
    session.held = new Set(["home.read", "home.manage"]);
}
function resident() {
    session.held = new Set(["home.read"]);
}
function visitor() {
    session.held = new Set();
    session.lentCameras = { [CAMERA_ID]: "view" };
}

beforeEach(() => {
    session.held = new Set();
    session.lentCameras = {};
    nasStanding.mockReset();
});

describe("a camera's address in a list", () => {
    it("reaches whoever manages the house", async () => {
        manager();
        const listed = await home.listCamerasAction();
        expect(listed.cameras?.map((entry) => entry.address)).toEqual([ADDRESS, ADDRESS]);
        const { overview: read } = await overview.placeOverviewAction();
        expect(read?.cameras.map((entry) => entry.address)).toEqual([ADDRESS, ADDRESS]);
    });

    it("stays from somebody who only lives there", async () => {
        resident();
        const listed = await home.listCamerasAction();
        expect(listed.cameras?.map((entry) => entry.address)).toEqual(["", ""]);
        const { overview: read } = await overview.placeOverviewAction();
        expect(read?.cameras.map((entry) => entry.address)).toEqual(["", ""]);
    });

    it("stays from a visitor lent the camera, on the list and on the Overview", async () => {
        visitor();
        const listed = await home.listCamerasAction();
        expect(listed.cameras).toHaveLength(1);
        expect(listed.cameras?.[0]).toMatchObject({ id: CAMERA_ID, address: "" });
        const { overview: read } = await overview.placeOverviewAction();
        expect(read?.cameras).toHaveLength(1);
        expect(read?.cameras[0]).toMatchObject({ id: CAMERA_ID, address: "" });
    });
});

describe("a camera's and an account's network details", () => {
    it("answer whoever manages the house", async () => {
        manager();
        expect(await home.cameraNetworkAction(CAMERA_ID)).toEqual({ details });
        expect(await home.accountNetworksAction()).toEqual({
            networks: [{ id: "lock:host", label: "Front lock", details }]
        });
    });

    it.each([
        ["somebody who only lives there", resident],
        ["a visitor", visitor]
    ])("refuse %s", async (_who, become) => {
        become();
        await expect(home.cameraNetworkAction(CAMERA_ID)).rejects.toThrow(refused);
        await expect(home.accountNetworksAction()).rejects.toThrow(refused);
    });
});

describe("a machine's network details", () => {
    it("answer for a machine of the reader's own", async () => {
        session.held = new Set(["deploy.read"]);
        expect(await machineNetworkAction("mine")).toEqual(details);
    });

    it("say nothing of a machine that is not theirs", async () => {
        session.held = new Set(["deploy.read"]);
        expect(await machineNetworkAction("lent-to-them")).toBeNull();
    });

    it("say nothing without the permission", async () => {
        expect(await machineNetworkAction("mine")).toBeNull();
    });
});

describe("a NAS's network details", () => {
    it("answer whoever manages it", async () => {
        nasStanding.mockResolvedValue({ manage: true, grants: {} });
        expect(await nasNetworkAction(NAS_ID)).toEqual(details);
    });

    it("say nothing to somebody lent it", async () => {
        nasStanding.mockResolvedValue({ manage: false, watch: true, grants: {} });
        expect(await nasNetworkAction(NAS_ID)).toBeNull();
    });

    it("say nothing to a stranger", async () => {
        nasStanding.mockResolvedValue(null);
        expect(await nasNetworkAction(NAS_ID)).toBeNull();
    });
});

describe("a UPS's network details", () => {
    it("answer its administrators, on its page and on the list", async () => {
        session.held = new Set(["system.manage"]);
        expect(await upsNetworkAction(UPS_ID)).toEqual(details);
        const answer = await (await upsList()).json();
        expect(answer.network).toEqual({ [UPS_ID]: details });
    });

    it("are refused to anybody else", async () => {
        await expect(upsNetworkAction(UPS_ID)).rejects.toThrow(refused);
        const answer = await upsList();
        expect(answer.status).toBe(403);
        expect(await answer.json()).not.toHaveProperty("network");
    });
});
