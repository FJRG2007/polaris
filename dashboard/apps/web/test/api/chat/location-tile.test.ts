/**
 * The tile route serves only the layers it knows, each from its fixed source,
 * and refuses a zoom a source does not draw rather than asking for it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fetched: string[] = [];

vi.mock("@/lib/session", () => ({
    backgroundUser: async () => ({ user: { id: "member" } }),
    sessionCan: async () => true
}));

const { GET } = await import("@/app/api/chat/location/tile/[z]/[x]/[y]/route");

function ask(z: number, x: number, y: number, layer?: string) {
    const query = layer ? `?layer=${layer}` : "";
    return GET(new Request(`http://polaris.test/api/chat/location/tile/${z}/${x}/${y}${query}`), {
        params: Promise.resolve({ z: String(z), x: String(x), y: String(y) })
    });
}

beforeEach(() => {
    fetched.length = 0;
    vi.stubGlobal("fetch", async (url: string) => {
        fetched.push(url);
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
    });
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
        expect(fetched).toEqual([]);
    });
});
