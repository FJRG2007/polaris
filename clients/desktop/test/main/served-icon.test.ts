/**
 * The season's icon as a host serves it: read from its manifest, so a host
 * whose page never reports still dresses the app (BUG-0049).
 */

import { describe, expect, it } from "vitest";
import { fetchServedIcon, servedIconOf } from "../../src/main/served-icon";

const ORIGIN = "https://polaris.example.test";

const seasonal = {
    name: "Polaris",
    icons: [
        { src: "/season-icon/winter.svg", sizes: "any", type: "image/svg+xml" },
        { src: "/season-icon/winter-192.png", sizes: "192x192", type: "image/png" },
        { src: "/season-icon/winter-512.png", sizes: "512x512", type: "image/png" }
    ]
};
const plain = { icons: [{ src: "/icon.svg" }, { src: "/polaris-mark-512.png" }] };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function answering(routes: Record<string, () => Response>) {
    const asked: string[] = [];
    const fetcher = async (url: string) => {
        asked.push(url);
        const route = routes[url];
        if (!route) throw new Error("unreachable");
        return route();
    };
    return { fetcher, asked };
}

describe("servedIconOf", () => {
    it("names the season and the largest PNG of it", () => {
        expect(servedIconOf(ORIGIN, seasonal)).toEqual({ season: "winter", url: `${ORIGIN}/season-icon/winter-512.png` });
    });

    it("is null for the plain icons, an unknown season, another origin or no manifest", () => {
        expect(servedIconOf(ORIGIN, plain)).toBeNull();
        expect(servedIconOf(ORIGIN, { icons: [{ src: "/season-icon/spring-512.png" }] })).toBeNull();
        expect(servedIconOf(ORIGIN, { icons: [{ src: "https://elsewhere.example.test/season-icon/winter-512.png" }] })).toBeNull();
        expect(servedIconOf(ORIGIN, "<html>")).toBeNull();
        expect(servedIconOf(ORIGIN, { icons: "x" })).toBeNull();
    });
});

describe("fetchServedIcon", () => {
    it("fetches the dressed mark the manifest names", async () => {
        const { fetcher, asked } = answering({
            [`${ORIGIN}/manifest.webmanifest`]: () => Response.json(seasonal),
            [`${ORIGIN}/season-icon/winter-512.png`]: () => new Response(PNG, { headers: { "content-type": "image/png" } })
        });
        const served = await fetchServedIcon(fetcher, ORIGIN);
        expect(served?.season).toBe("winter");
        expect(served?.png.equals(PNG)).toBe(true);
        expect(asked).toHaveLength(2);
    });

    it("is null for a host serving the plain icon or one from before the manifest", async () => {
        const plainHost = answering({ [`${ORIGIN}/manifest.webmanifest`]: () => Response.json(plain) });
        expect(await fetchServedIcon(plainHost.fetcher, ORIGIN)).toBeNull();
        const old = answering({ [`${ORIGIN}/manifest.webmanifest`]: () => new Response("", { status: 404 }) });
        expect(await fetchServedIcon(old.fetcher, ORIGIN)).toBeNull();
    });

    it("changes nothing when the host cannot be read", async () => {
        expect(await fetchServedIcon(answering({}).fetcher, ORIGIN)).toBeUndefined();
        const broken = answering({ [`${ORIGIN}/manifest.webmanifest`]: () => new Response("{not json", { status: 200 }) });
        expect(await fetchServedIcon(broken.fetcher, ORIGIN)).toBeUndefined();
        const down = answering({ [`${ORIGIN}/manifest.webmanifest`]: () => new Response("", { status: 502 }) });
        expect(await fetchServedIcon(down.fetcher, ORIGIN)).toBeUndefined();
        const notPng = answering({
            [`${ORIGIN}/manifest.webmanifest`]: () => Response.json(seasonal),
            [`${ORIGIN}/season-icon/winter-512.png`]: () => new Response("<html>", { headers: { "content-type": "text/html" } })
        });
        expect(await fetchServedIcon(notPng.fetcher, ORIGIN)).toBeUndefined();
    });
});
