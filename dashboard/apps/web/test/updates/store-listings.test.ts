import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

async function load() {
    return import("@polaris/ui/account-downloads/store-listings");
}

describe("listingState", () => {
    it("reads a listing, a missing one, and no answer", async () => {
        const { listingState } = await load();
        expect(listingState(200)).toBe(true);
        expect(listingState(404)).toBe(false);
        expect(listingState(410)).toBe(false);
        expect(listingState(429)).toBeNull();
        expect(listingState(503)).toBeNull();
    });
});

describe("androidStores", () => {
    it("offers only the stores that answer with the listing", async () => {
        const fetch = vi.fn(async (url: string) => ({
            status: url.includes("play.google.com") ? 200 : 404,
            body: null
        }));
        vi.stubGlobal("fetch", fetch);
        const { androidStores, PLAY_LISTING_URL } = await load();
        expect(await androidStores()).toEqual({ play: PLAY_LISTING_URL, fdroid: null });
    });

    it("holds the answer instead of asking the stores on every view", async () => {
        const fetch = vi.fn(async () => ({ status: 404, body: null }));
        vi.stubGlobal("fetch", fetch);
        const { androidStores } = await load();
        await androidStores();
        await androidStores();
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("keeps the last answer when a store stops answering", async () => {
        let up = true;
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                if (!up) throw new Error("offline");
                return { status: 200, body: null };
            })
        );
        vi.useFakeTimers();
        try {
            const { androidStores } = await load();
            const first = await androidStores();
            expect(first.play).not.toBeNull();
            up = false;
            vi.advanceTimersByTime(7 * 60 * 60 * 1000);
            expect(await androidStores()).toEqual(first);
        } finally {
            vi.useRealTimers();
        }
    });
});
