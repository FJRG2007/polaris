/**
 * What a browser is handed to play, and where it points.
 *
 * These two pieces are what stood between a phone and a live picture: the format
 * chosen for it, and one relative link in a playlist. Both are pure, both are
 * one line, and both are invisible when wrong - the page looks fine and shows a
 * still from four minutes ago.
 */

import { describe, expect, it } from "vitest";
import { rewriteMasterPlaylist } from "@polaris-app/places/src/lib/live";
import {
    hlsAssetPath,
    hlsMasterPath,
    isHlsFile,
    streamName
} from "@polaris-app/places/src/lib/relay";
import {
    FRAME_FRESH_MS,
    VERSIONED_STILL,
    lastFrame,
    nextTransport,
    otherTransport,
    preferredTransport,
    rememberFrame,
    stillSrc,
    streamSrc,
    transportOrder
} from "@polaris-app/places/src/lib/player";

describe("the master playlist", () => {
    it("points at a sibling of itself rather than one directory deeper", () => {
        const header = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="avc1.640029"\n';
        expect(rewriteMasterPlaylist(`${header}hls/playlist.m3u8?id=aB3xY9zQ`)).toBe(
            `${header}playlist.m3u8?id=aB3xY9zQ`
        );
    });

    it("leaves a playlist that was already relative alone", () => {
        expect(rewriteMasterPlaylist("#EXTM3U\nplaylist.m3u8?id=abc")).toBe(
            "#EXTM3U\nplaylist.m3u8?id=abc"
        );
    });

    it("does not touch a segment that happens to mention the same words", () => {
        const media = "#EXTINF:0.500,\nsegment.m4s?id=abc&n=7";
        expect(rewriteMasterPlaylist(media)).toBe(media);
    });
});

describe("what the relay is asked for", () => {
    it("asks for fragmented MP4 segments, which is the flavour Safari plays", () => {
        expect(hlsMasterPath("cam1", "main")).toBe(
            `/api/stream.m3u8?src=${encodeURIComponent(streamName("cam1", "main"))}&mp4`
        );
    });

    it("carries the session and the sequence a player was given, and nothing else", () => {
        expect(hlsAssetPath("segment.m4s", "aB3xY9zQ", "12")).toBe(
            "/api/hls/segment.m4s?id=aB3xY9zQ&n=12"
        );
        expect(hlsAssetPath("init.mp4", "aB3xY9zQ", null)).toBe("/api/hls/init.mp4?id=aB3xY9zQ");
    });

    it("refuses a file name that is not one of the five", () => {
        expect(isHlsFile("segment.m4s")).toBe(true);
        expect(isHlsFile("../streams")).toBe(false);
        expect(isHlsFile("frame.jpeg")).toBe(false);
    });
});

describe("choosing a format", () => {
    it("renders a stream fed by hand where there is no browser to ask, so the markup fetches nothing", () => {
        expect(preferredTransport()).toBe("mse");
    });

    it("tries every format once, best first, and then stops", () => {
        const order = transportOrder();
        expect(order[0]).toBe("mse");
        const tried = [order[0]!];
        for (let next = nextTransport(order[0]!); next; next = nextTransport(next))
            tried.push(next);
        expect(tried).toEqual(order);
        expect(new Set(tried).size).toBe(tried.length);
    });

    it("swaps to the other one, and back", () => {
        expect(otherTransport("mp4")).toBe("hls");
        expect(otherTransport("hls")).toBe("mp4");
    });

    it("never hands a browser the relay's own address", () => {
        for (const source of [
            streamSrc("cam1", "main", "mp4"),
            streamSrc("cam1", "sub", "hls"),
            stillSrc("cam1", 3)
        ]) {
            expect(source.startsWith("/api/home/cameras/cam1/")).toBe(true);
        }
    });

    it("asks for the quality it was given", () => {
        expect(streamSrc("cam1", "sub", "mp4")).toContain("q=sub");
        expect(streamSrc("cam1", "sub", "hls")).toContain("q=sub");
    });
});

describe("the frame a tile draws", () => {
    it("changes address every time, or the browser answers from its own cache and the picture freezes", () => {
        expect(stillSrc("cam1", 1)).not.toBe(stillSrc("cam1", 2));
    });

    it("is unique to this page as well, so the browser may keep it without freezing a picture", () => {
        const versioned = new URL(stillSrc("cam1", 4), "http://polaris.invalid").searchParams.get(
            "v"
        );
        expect(versioned).toMatch(VERSIONED_STILL);
        expect(versioned!.endsWith(".4")).toBe(true);
    });

    it("keeps the first one plain, so the server's markup matches the page that wakes up", () => {
        const first = new URL(stillSrc("cam1", 0), "http://polaris.invalid").searchParams.get("v");
        expect(first).toBe("0");
        expect(first).not.toMatch(VERSIONED_STILL);
    });

    it("asks for the size it will be drawn at", () => {
        expect(stillSrc("cam1", 0, 640)).toContain("w=640");
        expect(stillSrc("cam1", 0)).not.toContain("w=");
    });
});

describe("the frame a camera opens on", () => {
    it("is the one its tile showed a moment ago", () => {
        rememberFrame("cam-open", "/api/home/cameras/cam-open/snapshot?v=abc123.7", 1_000);
        expect(lastFrame("cam-open", 1_000 + FRAME_FRESH_MS)).toBe(
            "/api/home/cameras/cam-open/snapshot?v=abc123.7"
        );
    });

    it("is nothing once that picture is old enough to show something that is not there", () => {
        rememberFrame("cam-stale", "/api/home/cameras/cam-stale/snapshot?v=abc123.1", 1_000);
        expect(lastFrame("cam-stale", 1_001 + FRAME_FRESH_MS)).toBeNull();
        expect(lastFrame("cam-never")).toBeNull();
    });
});
