/**
 * Places' camera tool, called the way an MCP client calls it.
 *
 * What is pinned is that a camera is reached exactly as its snapshot route
 * reaches it: listed only where the person's reach covers it, watched only
 * after the route's own check (`requireCameraView`), and drawn through the same
 * relay call (`cameraStill`) at a bounded size. The picture goes back as MCP
 * image content beside a sentence, never the camera's address or credential.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    actingUser: vi.fn(),
    homeInstall: vi.fn(),
    listPlaces: vi.fn(),
    placesReach: vi.fn(),
    requireCameraView: vi.fn(),
    listCameras: vi.fn(),
    getCamera: vi.fn(),
    cameraStill: vi.fn()
}));

class CameraOfflineError extends Error {}
class HomeError extends Error {}

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/mcp/acting-user", () => ({ actingUser: mocks.actingUser }));
vi.mock("@/lib/i18n/request", () => ({ getLocale: async () => "en-US" }));
vi.mock("@polaris-app/places/src/lib/access", () => ({ homeInstall: mocks.homeInstall }));
vi.mock("@polaris-app/places/src/lib/home-error", () => ({ HomeError }));
vi.mock("@polaris-app/places/src/lib/places", () => ({ listPlaces: mocks.listPlaces }));
vi.mock("@polaris-app/places/src/lib/sharing", () => ({
    placesReach: mocks.placesReach,
    requireCameraView: mocks.requireCameraView,
    onlyReachable: <T extends { id: string }>(
        things: T[],
        allowed: true | ReadonlyMap<string, unknown>
    ) => (allowed === true ? things : things.filter((thing) => allowed.has(thing.id)))
}));
vi.mock("@polaris-app/places/src/lib/cameras", () => ({
    listCameras: mocks.listCameras,
    getCamera: mocks.getCamera
}));
vi.mock("@polaris-app/places/src/lib/live", () => ({
    cameraStill: mocks.cameraStill,
    CameraOfflineError
}));

const { placesExtension } = await import("@polaris-app/places/src/lib/places-extension");
const { handleMcpMessage } = await import("@/lib/mcp/protocol");
const { CallToolResultSchema } = await import("@modelcontextprotocol/sdk/types.js");

const TOOLS = await placesExtension.mcpTools!();
const SERVER = { name: "polaris", version: "1", instructions: "" };
const ADA = { id: "user-1", email: "ada@example.test", name: "Ada", isAdmin: false, sessionId: "" };
const INSTALL = { id: "install-1", ownerId: "owner-1", name: "Home" };
const FRONT = "44444444-4444-4444-8444-444444444444";
const YARD = "55555555-5555-4555-8555-555555555555";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

type ToolResult = {
    content: { type: string; text?: string; data?: string; mimeType?: string }[];
    isError?: boolean;
    structuredContent?: any;
};

async function call(args: Record<string, unknown>, scopes: string[] = ["places.cameras"]) {
    const reply = await handleMcpMessage(
        {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "places_camera_snapshot", arguments: args }
        },
        TOOLS,
        { userId: "user-1", isAdmin: false, scopes: scopes as never, grantId: "grant-1" },
        SERVER
    );
    return reply?.result as ToolResult;
}

function camera(id: string, name: string, extra: Record<string, unknown> = {}) {
    return {
        id,
        name,
        placeId: "place-1",
        zone: "Outside",
        vendor: "acme",
        address: "192.0.2.10",
        username: "admin",
        hasPassword: true,
        enabled: true,
        lastSeenAt: "2026-10-01T10:00:00.000Z",
        offlineSince: null,
        ...extra
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.actingUser.mockResolvedValue(ADA);
    mocks.homeInstall.mockResolvedValue(INSTALL);
    mocks.listPlaces.mockResolvedValue([{ id: "place-1", name: "Flat" }]);
    mocks.placesReach.mockResolvedValue({ everything: true, cameras: new Map() });
    mocks.requireCameraView.mockResolvedValue(undefined);
    mocks.getCamera.mockImplementation(async (_install: string, id: string) =>
        id === FRONT ? camera(FRONT, "Front door") : null
    );
    mocks.cameraStill.mockResolvedValue(JPEG);
});

describe("places_camera_snapshot", () => {
    it("needs its own scope: seeing devices does not open the cameras", async () => {
        const result = await call({ cameraId: FRONT }, ["places.read", "places.control"]);
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("places.cameras");
        expect(mocks.cameraStill).not.toHaveBeenCalled();
    });

    it("is advertised as read-only", () => {
        const tool = TOOLS.find((one) => one.name === "places_camera_snapshot");
        expect(tool?.readOnly).toBe(true);
        expect(tool?.scope).toBe("places.cameras");
    });

    it("lists only the cameras the person reaches, without an address or a login", async () => {
        mocks.placesReach.mockResolvedValue({
            everything: false,
            cameras: new Map([[FRONT, "view"]])
        });
        mocks.listCameras.mockResolvedValue([camera(FRONT, "Front door"), camera(YARD, "Yard")]);
        const result = await call({});
        expect(mocks.listCameras).toHaveBeenCalledWith(INSTALL.id);
        expect(result.structuredContent.cameras).toEqual([
            {
                id: FRONT,
                name: "Front door",
                place: "Flat",
                zone: "Outside",
                enabled: true,
                online: true,
                lastSeenAt: "2026-10-01T10:00:00.000Z"
            }
        ]);
        expect(JSON.stringify(result)).not.toContain("192.0.2.10");
        expect(JSON.stringify(result)).not.toContain("admin");
        expect(mocks.cameraStill).not.toHaveBeenCalled();
    });

    it("sends the picture as image content, through the route's own check and relay call", async () => {
        const result = await call({ cameraId: FRONT });
        expect(mocks.requireCameraView).toHaveBeenCalledWith(ADA, FRONT);
        expect(mocks.cameraStill).toHaveBeenCalledWith(
            INSTALL.id,
            FRONT,
            expect.objectContaining({ width: 640, signal: expect.any(AbortSignal) })
        );
        expect(CallToolResultSchema.parse(result).content).toEqual([
            { type: "text", text: expect.stringContaining("Front door") },
            { type: "image", data: JPEG.toString("base64"), mimeType: "image/jpeg" }
        ]);
        expect(result.structuredContent).toMatchObject({
            cameraId: FRONT,
            name: "Front door",
            bytes: JPEG.length
        });
    });

    it("asks for the width it was given, within bounds", async () => {
        await call({ cameraId: FRONT, width: 320 });
        expect(mocks.cameraStill.mock.calls[0]![2]).toMatchObject({ width: 320 });
        const tooWide = await handleMcpMessage(
            {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: {
                    name: "places_camera_snapshot",
                    arguments: { cameraId: FRONT, width: 4000 }
                }
            },
            TOOLS,
            { userId: "user-1", isAdmin: false, scopes: ["places.cameras"], grantId: "g" },
            SERVER
        );
        expect(tooWide?.error?.message).toContain("width");
    });

    it("refuses a camera that is not shared with the person, before asking the relay", async () => {
        mocks.requireCameraView.mockRejectedValue(
            new HomeError("That camera is not shared with you")
        );
        const result = await call({ cameraId: YARD });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toBe("That camera is not shared with you");
        expect(mocks.cameraStill).not.toHaveBeenCalled();
    });

    it("says why there is no picture when the camera is off or asleep", async () => {
        mocks.cameraStill.mockRejectedValue(new CameraOfflineError("This camera is switched off"));
        const result = await call({ cameraId: FRONT });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toBe("This camera is switched off");
    });

    it("asks again smaller rather than sending a picture over the size cap", async () => {
        mocks.cameraStill
            .mockResolvedValueOnce(Buffer.alloc(2 * 1024 * 1024, 1))
            .mockResolvedValueOnce(JPEG);
        const result = await call({ cameraId: FRONT, width: 1280 });
        expect(mocks.cameraStill).toHaveBeenCalledTimes(2);
        expect(mocks.cameraStill.mock.calls[1]![2]).toMatchObject({ width: 320 });
        expect(result.content[1]).toMatchObject({ type: "image", data: JPEG.toString("base64") });
    });

    it("refuses rather than sends a picture still over the cap at the smallest size", async () => {
        mocks.cameraStill.mockResolvedValue(Buffer.alloc(2 * 1024 * 1024, 1));
        const result = await call({ cameraId: FRONT });
        expect(result.isError).toBe(true);
        expect(result.content).toHaveLength(1);
    });
});
