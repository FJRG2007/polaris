/**
 * What a browser is handed to play, and where it points.
 *
 * These two pieces are what stood between a phone and a live picture: the format
 * chosen for it, and one relative link in a playlist. Both are pure, both are
 * one line, and both are invisible when wrong - the page looks fine and shows a
 * still from four minutes ago.
 */

import { describe, expect, it } from "vitest";
import { rewriteMasterPlaylist } from "@/lib/home/live";
import { hlsAssetPath, hlsMasterPath, isHlsFile, streamName } from "@/lib/home/relay";
import { otherTransport, preferredTransport, stillSrc, streamSrc } from "@/lib/home/player";

describe("the master playlist", () => {
    it("points at a sibling of itself rather than one directory deeper", () => {
        const header = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS=\"avc1.640029\"\n";
        expect(rewriteMasterPlaylist(`${header}hls/playlist.m3u8?id=aB3xY9zQ`)).toBe(
            `${header}playlist.m3u8?id=aB3xY9zQ`
        );
    });

    it("leaves a playlist that was already relative alone", () => {
        expect(rewriteMasterPlaylist("#EXTM3U\nplaylist.m3u8?id=abc")).toBe("#EXTM3U\nplaylist.m3u8?id=abc");
    });

    it("does not touch a segment that happens to mention the same words", () => {
        const media = "#EXTINF:0.500,\nsegment.m4s?id=abc&n=7";
        expect(rewriteMasterPlaylist(media)).toBe(media);
    });
});

describe("what the relay is asked for", () => {
    it("asks for fragmented MP4 segments, which is the flavour Safari plays", () => {
        expect(hlsMasterPath("cam1", "main")).toBe(`/api/stream.m3u8?src=${encodeURIComponent(streamName("cam1", "main"))}&mp4`);
    });

    it("carries the session and the sequence a player was given, and nothing else", () => {
        expect(hlsAssetPath("segment.m4s", "aB3xY9zQ", "12")).toBe("/api/hls/segment.m4s?id=aB3xY9zQ&n=12");
        expect(hlsAssetPath("init.mp4", "aB3xY9zQ", null)).toBe("/api/hls/init.mp4?id=aB3xY9zQ");
    });

    it("refuses a file name that is not one of the five", () => {
        expect(isHlsFile("segment.m4s")).toBe(true);
        expect(isHlsFile("../streams")).toBe(false);
        expect(isHlsFile("frame.jpeg")).toBe(false);
    });
});

describe("choosing a format", () => {
    it("falls back to MP4 where there is no browser to ask", () => {
        expect(preferredTransport()).toBe("mp4");
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
