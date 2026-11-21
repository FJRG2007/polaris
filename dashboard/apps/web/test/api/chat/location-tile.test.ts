/**
 * The tile route serves only the layers it knows, each from its fixed source,
 * and refuses a zoom a source does not draw rather than asking for it. Satellite
 * imagery comes from the provider an administrator chose: the key goes into the
 * provider's address on the server and never into what the browser receives,
 * and a provider that refuses falls back to the free default, saying why.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetched: string[] = [];
let answer: (url: string) => Response = () => image();
let integration: { enabled: boolean; config: Record<string, unknown>; hasSecret: boolean; updatedAt: string } | null =
    null;
let secret: string | null = null;
const settings = new Map<string, string>();

vi.mock("@/lib/session", () => ({
    backgroundUser: async () => ({ user: { id: "member" } }),
    sessionCan: async () => true
}));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => (integration ? { provider: "satellite-imagery", ...integration } : null),
    getIntegrationSecret: async () => secret
}));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => {
        if (value === null) settings.delete(key);
        else settings.set(key, value);
    }
}));

const { GET } = await import("@/app/api/chat/location/tile/[z]/[x]/[y]/route");
const { GET: imageryInfo } = await import("@/app/api/chat/location/imagery/route");
const { forgetImagery, readImageryFailure } = await import("@/lib/map-imagery");

const KEY = "fixture-key-0123456789abcdef";

function image(): Response {
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
}

function ask(z: number, x: number, y: number, layer?: string) {
    const query = layer ? `?layer=${layer}` : "";
    return GET(new Request(`http://polaris.test/api/chat/location/tile/${z}/${x}/${y}${query}`), {
        params: Promise.resolve({ z: String(z), x: String(x), y: String(y) })
    });
}

function keyed(provider: "maptiler" | "esri", updatedAt = "2026-11-21T10:00:00.000Z") {
    integration = { enabled: true, config: { provider }, hasSecret: true, updatedAt };
    secret = KEY;
}

async function everything(response: Response): Promise<string> {
    const headers = JSON.stringify([...response.headers.entries()]);
    const body = Buffer.from(await response.arrayBuffer()).toString("latin1");
    return headers + body;
}

beforeEach(() => {
    fetched.length = 0;
    integration = null;
    secret = null;
    settings.clear();
    answer = () => image();
    forgetImagery();
    vi.stubGlobal("fetch", async (url: string) => {
        fetched.push(url);
        return answer(url);
    });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("the map tile route", () => {
    it("fetches satellite imagery and its labels from their own sources", async () => {
        expect((await ask(14, 8000, 6000, "imagery")).status).toBe(200);
        expect((await ask(14, 8000, 6000, "labels")).status).toBe(200);
        expect(fetched).toEqual([
            "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/14/6000/8000.jpg",
            "https://tiles.maps.eox.at/wmts/1.0.0/overlay_bright_3857/default/g/14/6000/8000.png"
        ]);
    });

    it("keeps streets on OpenStreetMap when no layer is named", async () => {
        expect((await ask(3, 1, 2)).status).toBe(200);
        expect(fetched).toEqual(["https://tile.openstreetmap.org/3/1/2.png"]);
    });

    it("refuses an unknown layer and a zoom the source does not draw", async () => {
        expect((await ask(3, 1, 2, "https://evil.example")).status).toBe(404);
        expect((await ask(15, 1, 2, "labels")).status).toBe(404);
        expect((await ask(19, 1, 2, "imagery")).status).toBe(404);
        expect(fetched).toEqual([]);
    });

    it("keeps the default when the provider is switched off or has no key", async () => {
        integration = { enabled: false, config: { provider: "maptiler" }, hasSecret: true, updatedAt: "2026-11-21T10:00:00.000Z" };
        secret = KEY;
        await ask(5, 1, 2, "imagery");
        forgetImagery();
        integration = { enabled: true, config: { provider: "esri" }, hasSecret: false, updatedAt: "2026-11-21T10:00:00.000Z" };
        secret = null;
        await ask(5, 1, 3, "imagery");
        expect(fetched.every((url) => url.startsWith("https://tiles.maps.eox.at/"))).toBe(true);
    });

    it("lets the instance's own imagery address override every provider", async () => {
        vi.stubEnv("POLARIS_MAP_IMAGERY_URL", "https://tiles.internal.test/{z}/{x}/{y}.jpg");
        keyed("maptiler");
        expect((await ask(4, 3, 2, "imagery")).status).toBe(200);
        expect(fetched).toEqual(["https://tiles.internal.test/4/3/2.jpg"]);
    });
});

describe("a keyed imagery provider", () => {
    it("builds MapTiler's address with the key, and keeps the key out of the answer", async () => {
        keyed("maptiler");
        const response = await ask(20, 5, 6, "imagery");
        expect(response.status).toBe(200);
        expect(fetched).toEqual([`https://api.maptiler.com/tiles/satellite-v2/20/5/6.jpg?key=${KEY}`]);
        expect(await everything(response)).not.toContain(KEY);
    });

    it("builds Esri's address with y before x and the key as the token", async () => {
        keyed("esri");
        const response = await ask(19, 5, 6, "imagery");
        expect(response.status).toBe(200);
        expect(fetched).toEqual([
            `https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/19/6/5?token=${KEY}`
        ]);
        expect(await everything(response)).not.toContain(KEY);
        // Past Esri's depth the map stretches; the route does not ask.
        expect((await ask(20, 5, 6, "imagery")).status).toBe(404);
    });

    it("falls back to the default when the key is refused, and says why", async () => {
        keyed("maptiler");
        answer = (url) => (url.includes("maptiler") ? new Response("no", { status: 403 }) : image());
        const response = await ask(10, 5, 6, "imagery");
        expect(response.status).toBe(200);
        expect(response.headers.get("x-polaris-imagery-fallback")).toBe("refused");
        expect(response.headers.get("cache-control")).toBe("private, max-age=60");
        expect(fetched[1]).toBe("https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/10/6/5.jpg");
        expect(await readImageryFailure()).toMatchObject({ provider: "maptiler", reason: "refused", status: 403 });

        // Stood down: the next tile goes straight to the default, and maps are told so.
        fetched.length = 0;
        await ask(10, 5, 7, "imagery");
        expect(fetched).toEqual(["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/10/7/5.jpg"]);
        const view = await (await imageryInfo()).json();
        expect(view.provider).toBe("default");
    });

    it("reads Esri's 200-with-JSON refusal as a refusal", async () => {
        keyed("esri");
        answer = (url) =>
            url.includes("arcgis")
                ? new Response('{"error":{"code":498}}', { headers: { "content-type": "application/json" } })
                : image();
        const response = await ask(8, 1, 1, "imagery");
        expect(response.headers.get("x-polaris-imagery-fallback")).toBe("refused");
    });

    it("falls back for one missing tile without standing the provider down", async () => {
        keyed("maptiler");
        answer = (url) => (url.includes("/9/") && url.includes("maptiler") ? new Response("", { status: 404 }) : image());
        expect((await ask(9, 1, 1, "imagery")).headers.get("x-polaris-imagery-fallback")).toBe("unreachable");
        expect(await readImageryFailure()).toBeNull();
        fetched.length = 0;
        await ask(10, 1, 1, "imagery");
        expect(fetched[0]).toContain("api.maptiler.com");
    });

    it("tells the map how deep to draw and whom to credit, never the key", async () => {
        keyed("maptiler");
        const response = await imageryInfo();
        const text = await response.text();
        expect(text).not.toContain(KEY);
        const view = JSON.parse(text);
        expect(view).toMatchObject({ provider: "maptiler", nativeMaxZoom: 22 });
        expect(view.credits.map((line: { text: string }) => line.text)).toContain("© MapTiler");
        expect(view.version).toMatch(/^maptiler-/);
    });
});
