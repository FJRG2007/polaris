/**
 * The route a wall polls for which cameras the relay serves.
 *
 * Signed out is refused, somebody who reaches nothing of Places is refused, a
 * visitor lent one camera hears about that camera and no other, and a resident
 * hears about every camera the relay is serving.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

type Reach = {
    everything: boolean;
    cameras: Map<string, string>;
    devices: Map<string, string>;
    deviceActions: Map<string, string>;
    upses: Map<string, string>;
};

function reachOf(everything: boolean, cameras: string[] = []): Reach {
    return {
        everything,
        cameras: new Map(cameras.map((id) => [id, "view"])),
        devices: new Map(),
        deviceActions: new Map(),
        upses: new Map()
    };
}

let caller: unknown = { id: "user-1" };
let reach: Reach = reachOf(true);
let published: string[] | null = [];

vi.mock("@/lib/api-session", () => ({
    apiUser: async () => caller
}));
vi.mock("@polaris-app/places/src/lib/access", () => ({
    homeInstall: async () => ({ id: "install-1", ownerId: "owner", name: "Home" })
}));
vi.mock("@polaris-app/places/src/lib/sharing", async (actual) => ({
    ...(await actual<typeof import("@polaris-app/places/src/lib/sharing")>()),
    placesReach: async () => reach
}));
vi.mock("@polaris-app/places/src/lib/cameras", () => ({
    getCamera: async () => null,
    listCameras: async () => [
        { id: "front", reachVia: "local" },
        { id: "yard", reachVia: "local" },
        { id: "garage", reachVia: "local" }
    ]
}));
vi.mock("@polaris-app/places/src/lib/relay", async (actual) => ({
    ...(await actual<typeof import("@polaris-app/places/src/lib/relay")>()),
    relayEndpoint: async () => ({ url: "http://relay.test" }),
    publishedStreams: async () => published
}));

const { GET } = await import("@polaris-app/places/src/routes/api/home/cameras/live/route");

afterEach(() => {
    caller = { id: "user-1" };
    reach = reachOf(true);
    published = [];
});

describe("the live cameras route", () => {
    it("refuses somebody signed out", async () => {
        caller = new Response("Unauthorized", { status: 401 });
        expect((await GET()).status).toBe(401);
    });

    it("refuses somebody who reaches nothing of Places", async () => {
        reach = reachOf(false);
        expect((await GET()).status).toBe(403);
    });

    it("answers a resident with every camera the relay serves, never from a cache", async () => {
        published = ["front-main", "yard-sub", "garage-main"];
        const response = await GET();
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({ live: ["front", "garage"] });
    });

    it("answers a visitor with only the cameras they were lent", async () => {
        reach = reachOf(false, ["yard"]);
        published = ["front-main", "yard-main"];
        expect(await (await GET()).json()).toEqual({ live: ["yard"] });
    });

    it("answers nothing live while the relay is not answering", async () => {
        published = null;
        expect(await (await GET()).json()).toEqual({ live: [] });
    });
});
