// @vitest-environment jsdom

/**
 * Reading ahead in Drive's preview: a preload is asked for as one, the picture
 * is then shown from this browser, its view recorded when it is shown, and only
 * a few are held.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    cachedPicture,
    dropPictures,
    preloadPicture,
    recordView
} from "@/lib/drive/picture-cache";

const calls: { url: string; init?: RequestInit }[] = [];
let made = 0;

beforeEach(() => {
    calls.length = 0;
    made = 0;
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
            calls.push({ url, init });
            // A string body: Node 22's Response does not read jsdom's Blob, so
            // a Blob body made blob() reject there and the preload never landed.
            return new Response("x", { status: 200 });
        })
    );
    URL.createObjectURL = vi.fn(() => `blob:picture-${(made += 1)}`);
    URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
    dropPictures();
    vi.unstubAllGlobals();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Until a preload has landed. Reading a response's blob takes more than one
 *  turn of the event loop, so one `settle` is not enough to wait for it. */
const landed = (src: string) => vi.waitFor(() => expect(cachedPicture(src)).not.toBeNull());

describe("the picture cache", () => {
    it("asks for a preload as one, and shows it from the browser once here", async () => {
        const src = "/api/drive/download?c=c1&p=%2Fa.jpg&disposition=inline";
        expect(cachedPicture(src)).toBeNull();
        preloadPicture(src);
        preloadPicture(src);
        await landed(src);
        expect(calls.map((call) => call.url)).toEqual([`${src}&purpose=preload`]);
        expect(cachedPicture(src)).toBe("blob:picture-1");
    });

    it("records a shown picture's view with a one-byte read of its own address", () => {
        recordView("/api/drive/download?p=%2Fa.jpg&disposition=inline");
        expect(calls[0]?.url).toBe("/api/drive/download?p=%2Fa.jpg&disposition=inline");
        expect((calls[0]?.init?.headers as Record<string, string>).range).toBe("bytes=0-0");
    });

    it("holds only a few, letting the oldest go", async () => {
        for (let index = 0; index < 10; index += 1) preloadPicture(`/p?n=${index}`);
        await landed("/p?n=9");
        expect(cachedPicture("/p?n=0")).toBeNull();
        expect(cachedPicture("/p?n=1")).toBeNull();
        expect(cachedPicture("/p?n=9")).not.toBeNull();
    });

    it("forgets a picture the server refused, so the preview fetches it itself", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 403 })));
        preloadPicture("/p?n=x");
        await settle();
        expect(cachedPicture("/p?n=x")).toBeNull();
    });
});
