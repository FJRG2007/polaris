/**
 * The picker's "Search the web" tab, server side: what a search accepts, that
 * identical searches reach the image index once, and that every byte it serves
 * comes through the guarded fetch - so an upstream answer that names an address
 * on this server's own network is refused, never reached.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({
    fetched: [] as string[],
    answer: (_address: string): Response | null => null
}));

vi.mock("undici", () => ({
    Agent: class {},
    fetch: async (input: URL | string) => {
        const address = String(input);
        network.fetched.push(address);
        const canned = network.answer(address);
        if (!canned) throw new Error("nothing there");
        return canned;
    }
}));

vi.mock("node:dns/promises", () => ({
    lookup: async (hostname: string) => {
        const addresses: Record<string, string> = {
            "api.openverse.org": "93.184.216.34",
            "live.staticflickr.com": "93.184.216.35",
            "commons.wikimedia.org": "93.184.216.36",
            "upload.wikimedia.org": "93.184.216.37",
            "inside.test": "10.0.0.5"
        };
        const address = addresses[hostname];
        if (!address) throw new Error("not found");
        return [{ address, family: 4 }];
    }
}));

vi.mock("@polaris/db", () => ({ prisma: {} }));

const { searchWebImages, webImageBytes, forgetWebImages, WebImagesUnavailable } = await import(
    "@/lib/web-images/search"
);
const { webImageSearchSchema, webImageFileSchema } = await import("@/lib/web-images/shape");

const ID = "f561777d-24ea-483f-9cf8-f17aa1fd6aa3";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const image = (bytes: Uint8Array, type = "image/png") =>
    new Response(bytes, { status: 200, headers: { "content-type": type } });
const isSearch = (address: string) => address.startsWith("https://api.openverse.org/v1/images/?");

function openverseResult(overrides: Record<string, unknown> = {}) {
    return {
        id: ID,
        title: "Mountains",
        url: "https://live.staticflickr.com/7539/mountains_b.jpg",
        thumbnail: `https://api.openverse.org/v1/images/${ID}/thumb/`,
        creator: "Someone",
        creator_url: "https://www.flickr.com/photos/someone",
        license: "by-sa",
        license_version: "2.0",
        license_url: "https://creativecommons.org/licenses/by-sa/2.0/",
        foreign_landing_url: "https://www.flickr.com/photos/someone/1",
        filetype: null,
        mature: false,
        width: 1024,
        height: 680,
        ...overrides
    };
}

beforeEach(() => {
    forgetWebImages();
    network.fetched.length = 0;
    network.answer = () => null;
});

describe("what a search accepts", () => {
    it("normalizes the query and defaults to page one with SafeSearch on", () => {
        expect(webImageSearchSchema.parse({ q: "  Snowy   Mountain " })).toEqual({
            q: "snowy mountain",
            page: 1,
            safe: true
        });
        expect(webImageSearchSchema.parse({ q: "cat", page: "3", safe: "0" })).toEqual({
            q: "cat",
            page: 3,
            safe: false
        });
    });

    it("refuses an empty, overlong or out-of-range search", () => {
        for (const input of [
            { q: "   " },
            { q: "a".repeat(201) },
            { q: "cat", page: "0" },
            { q: "cat", page: "13" },
            { q: "cat", page: "1.5" },
            { q: "cat", safe: "yes" }
        ]) {
            expect(webImageSearchSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
        }
    });

    it("takes only an id a search hands out, never an address", () => {
        expect(webImageFileSchema.safeParse({ id: `ov:${ID}` }).success).toBe(true);
        expect(webImageFileSchema.safeParse({ id: "wc:125216708", size: "full" }).success).toBe(true);
        for (const id of ["https://inside.test/x.png", "ov:../../admin", "wc:0", "ov:", `ov:${ID}?x=1`]) {
            expect(webImageFileSchema.safeParse({ id }).success, id).toBe(false);
        }
    });
});

describe("asking the index", () => {
    it("asks Openverse with SafeSearch on, and keeps the credit", async () => {
        network.answer = (address) => (isSearch(address) ? json({ results: [openverseResult()], page_count: 120 }) : null);
        const found = await searchWebImages("mountain", 1, true);
        expect(network.fetched).toHaveLength(1);
        const asked = new URL(network.fetched[0]!);
        expect(asked.searchParams.get("mature")).toBe("false");
        expect(asked.searchParams.get("page_size")).toBe("20");
        expect(found.more).toBe(true);
        expect(found.results[0]).toMatchObject({
            id: `ov:${ID}`,
            title: "Mountains",
            credit: { provider: "openverse", license: "CC BY-SA 2.0", creator: "Someone" }
        });
    });

    it("drops a result flagged mature, and one in a type the picker cannot hand back", async () => {
        network.answer = () =>
            json({
                results: [
                    openverseResult({ mature: true }),
                    openverseResult({ id: "a561777d-24ea-483f-9cf8-f17aa1fd6aa3", filetype: "svg" })
                ],
                page_count: 1
            });
        expect((await searchWebImages("mountain", 1, true)).results).toEqual([]);
    });

    it("asks upstream once for a thousand identical searches, and answers the next from memory", async () => {
        network.answer = () => json({ results: [openverseResult()], page_count: 1 });
        const answers = await Promise.all(Array.from({ length: 1000 }, () => searchWebImages("cat", 1, true)));
        expect(new Set(answers.map((one) => one.results[0]?.id))).toEqual(new Set([`ov:${ID}`]));
        await searchWebImages("cat", 1, true);
        expect(network.fetched).toHaveLength(1);
    });

    it("keeps SafeSearch off and on apart", async () => {
        network.answer = () => json({ results: [openverseResult()], page_count: 1 });
        await searchWebImages("cat", 1, true);
        await searchWebImages("cat", 1, false);
        expect(network.fetched).toHaveLength(2);
    });

    it("with SafeSearch on, never falls back to an unfiltered source", async () => {
        network.answer = (address) => (address.includes("openverse") ? json({}, 429) : json({ query: { pages: [] } }));
        await expect(searchWebImages("cat", 1, true)).rejects.toBeInstanceOf(WebImagesUnavailable);
        expect(network.fetched.every((one) => one.includes("api.openverse.org"))).toBe(true);
    });

    it("with SafeSearch off, falls back to Wikimedia Commons", async () => {
        const commons = {
            pageid: 125216708,
            title: "File:Ama Dablam.jpg",
            index: 1,
            imageinfo: [
                {
                    url: "https://upload.wikimedia.org/a.jpg",
                    thumburl: "https://upload.wikimedia.org/330px-a.jpg",
                    mime: "image/jpeg",
                    size: 7_000_000,
                    width: 4032,
                    height: 2688,
                    descriptionurl: "https://commons.wikimedia.org/wiki/File:Ama_Dablam.jpg",
                    extmetadata: {
                        Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:X">X</a>' },
                        LicenseShortName: { value: "CC BY-SA 4.0" }
                    }
                }
            ]
        };
        network.answer = (address) =>
            address.includes("openverse") ? json({}, 503) : json({ query: { pages: [commons] } });
        const found = await searchWebImages("ama dablam", 1, false);
        expect(found.results[0]).toMatchObject({
            id: "wc:125216708",
            title: "Ama Dablam",
            credit: { provider: "wikimedia", creator: "X", license: "CC BY-SA 4.0" }
        });
    });
});

describe("the bytes", () => {
    it("serves a thumbnail by the bytes' own type, fetched once for every reader", async () => {
        network.answer = (address) =>
            isSearch(address)
                ? json({ results: [openverseResult()], page_count: 1 })
                : address.endsWith("/thumb/")
                  ? image(PNG, "image/webp")
                  : null;
        await searchWebImages("mountain", 1, true);
        const first = await webImageBytes(`ov:${ID}`, "thumb");
        const second = await webImageBytes(`ov:${ID}`, "thumb");
        expect(first?.type).toBe("image/png");
        expect(first?.name).toBe("Mountains.png");
        expect(second).toBe(first);
        expect(network.fetched.filter((one) => one.endsWith("/thumb/"))).toHaveLength(1);
    });

    it("refuses an image an upstream answer places on a private address", async () => {
        network.answer = (address) =>
            isSearch(address)
                ? json({
                      results: [
                          openverseResult({ url: "https://inside.test/x.png", thumbnail: "https://10.0.0.7/t.png" })
                      ],
                      page_count: 1
                  })
                : image(PNG);
        await searchWebImages("mountain", 1, true);
        expect(await webImageBytes(`ov:${ID}`, "thumb")).toBeNull();
        expect(await webImageBytes(`ov:${ID}`, "full")).toBeNull();
        expect(network.fetched.some((one) => one.includes("inside.test") || one.includes("10.0.0.7"))).toBe(false);
    });

    it("refuses bytes that are not a PNG, JPEG, WebP or GIF, whatever they are called", async () => {
        network.answer = (address) =>
            isSearch(address)
                ? json({ results: [openverseResult()], page_count: 1 })
                : image(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/png");
        await searchWebImages("mountain", 1, true);
        expect(await webImageBytes(`ov:${ID}`, "full")).toBeNull();
    });

    it("finds an id it never handed out by asking the provider for it", async () => {
        network.answer = (address) =>
            address === `https://api.openverse.org/v1/images/${ID}/`
                ? json(openverseResult())
                : address.startsWith("https://live.staticflickr.com/")
                  ? image(PNG)
                  : null;
        expect((await webImageBytes(`ov:${ID}`, "full"))?.credit.license).toBe("CC BY-SA 2.0");
    });
});
