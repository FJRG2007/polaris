/**
 * How often a camera can show a different picture.
 *
 * The relay holds each decoded frame for a window and hands the same one to
 * everybody who asks inside it. That window exists for the wall: twelve tiles
 * refreshing together must cost one decode per camera rather than one per tile.
 *
 * It is also a ceiling nobody could see. Asking four times a second against a
 * one-second window returns the picture already on screen three times out of
 * four - which is what "it lags, it looks like frames rather than video" is, and
 * no amount of asking faster in the browser could have fixed it. So the window
 * is the caller's to choose, and the two callers want opposite things.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** What `snapshot` was asked for, in order. */
const asked: { quality: string; options: { width?: number; cacheMs?: number } }[] = [];

vi.mock("@/lib/home/cameras", () => ({
    getCamera: async (_install: string, id: string) => ({ id, enabled: true, reachVia: null })
}));

vi.mock("@/lib/home/relay", () => ({
    relayEndpoint: async () => ({ baseUrl: "http://relay:1984", key: "k" }),
    relayServerFor: () => null,
    snapshot: async (
        _endpoint: unknown,
        _cameraId: string,
        quality: string,
        options: { width?: number; cacheMs?: number }
    ) => {
        asked.push({ quality, options });
        return Buffer.from([1, 2, 3, 4]);
    },
    streamPath: () => "/api/stream.mp4",
    relayStream: async () => ({ ok: false, body: null, headers: new Headers() }),
    hlsMasterPath: () => "/api/stream.m3u8",
    hlsAssetPath: () => "/api/hls/playlist.m3u8"
}));

const live = await import("../../src/lib/home/live");

beforeEach(() => {
    asked.length = 0;
});

describe("the window a still is cached for", () => {
    it("is a second for the wall, so tiles share one decode", async () => {
        await live.cameraStill("install", "cam-1", { width: 640 });

        // Twelve tiles asking together get one frame between them. This is the
        // reason the window exists and it is not being given up.
        expect(asked[0]?.options.cacheMs).toBe(1000);
    });

    it("is much shorter for one camera being watched on its own", async () => {
        await live.cameraStill("install", "cam-1", { width: 640, smooth: true });

        const held = asked[0]?.options.cacheMs ?? 0;
        // Enough for several different pictures a second, which is the whole
        // difference between a view somebody can follow and one that reads as
        // broken. Nothing else is competing for the relay in this case.
        expect(held).toBeGreaterThan(0);
        expect(held).toBeLessThanOrEqual(300);
    });

    it("asks for the size it will be drawn at, and always the small stream", async () => {
        await live.cameraStill("install", "cam-1", { width: 640, smooth: true });

        // A camera's own frame is several thousand pixels across. Sending that
        // several times a second is most of a megabyte over and over, which is
        // the cost that would make asking often impossible.
        expect(asked[0]?.options.width).toBe(640);
        expect(asked[0]?.quality).toBe("sub");
    });
});
