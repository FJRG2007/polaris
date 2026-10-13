/**
 * Reading what somebody scrobbles to Last.fm, for the card beside their name.
 *
 * What is pinned:
 * - one request per read, with the documented parameters and `limit=1`;
 * - only a track Last.fm marks as playing now is a song; the last one scrobbled
 *   an hour ago is nothing;
 * - a lone track (an object, not a list) is read the same as a list of them;
 * - Last.fm's error codes become the three things a caller can act on: wait
 *   (29), the key is refused (10, 26), no such user (6);
 * - a typed name is trimmed, bounded, and compared without case;
 * - "Listen along" for such a song is a Spotify search for it.
 */

import { lastfmNameSchema, sameLastfmName } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
    replies: [] as Array<{ status: number; body: unknown }>,
    urls: [] as string[]
};

vi.stubGlobal("fetch", async (input: string | URL) => {
    const next = state.replies.shift();
    if (!next) throw new Error(`no reply queued for ${String(input)}`);
    state.urls.push(String(input));
    return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        headers: new Headers(),
        json: async () => next.body,
        text: async () => JSON.stringify(next.body)
    } as unknown as Response;
});

const lastfm = await import("@/lib/connections/lastfm");
const search = await import("@/lib/connections/spotify-search");

function playing(overrides: Record<string, unknown> = {}) {
    return {
        artist: { mbid: "", "#text": "Example Artist" },
        name: "Example Song",
        album: { mbid: "", "#text": "Example Album" },
        url: "https://www.last.fm/music/Example+Artist/_/Example+Song",
        image: [
            { size: "small", "#text": "https://lastfm.freetls.fastly.net/i/u/34s/a.png" },
            { size: "extralarge", "#text": "https://lastfm.freetls.fastly.net/i/u/300x300/a.png" }
        ],
        "@attr": { nowplaying: "true" },
        ...overrides
    };
}

beforeEach(() => {
    state.replies = [];
    state.urls = [];
});

describe("reading what is playing", () => {
    it("asks for one recent track, with the key, as JSON", async () => {
        state.replies.push({ status: 200, body: { recenttracks: { track: [playing()] } } });
        const track = await lastfm.readLastfmPlaying("key-1", "example_user");
        const url = new URL(state.urls[0]!);
        expect(url.origin + url.pathname).toBe("https://ws.audioscrobbler.com/2.0/");
        expect(Object.fromEntries(url.searchParams)).toEqual({
            method: "user.getrecenttracks",
            user: "example_user",
            api_key: "key-1",
            format: "json",
            limit: "1"
        });
        expect(track).toEqual({
            key: "lastfm:example artist|example song",
            name: "Example Song",
            artists: "Example Artist",
            album: "Example Album",
            imageUrl: "https://lastfm.freetls.fastly.net/i/u/300x300/a.png",
            linkUrl: "https://www.last.fm/music/Example+Artist/_/Example+Song"
        });
    });

    it("reads a lone track and the attribute written straight on it", async () => {
        const { "@attr": _drop, ...bare } = playing();
        state.replies.push({
            status: 200,
            body: { recenttracks: { track: { ...bare, nowplaying: "true" } } }
        });
        expect((await lastfm.readLastfmPlaying("k", "u"))?.name).toBe("Example Song");
    });

    it("is nothing when the newest track is only the last one scrobbled", async () => {
        state.replies.push({
            status: 200,
            body: {
                recenttracks: {
                    track: [playing({ "@attr": undefined, date: { uts: "1", "#text": "x" } })]
                }
            }
        });
        expect(await lastfm.readLastfmPlaying("k", "u")).toBeNull();
        state.replies.push({ status: 200, body: { recenttracks: { track: [] } } });
        expect(await lastfm.readLastfmPlaying("k", "u")).toBeNull();
    });

    it("drops a picture that is not an https address", async () => {
        state.replies.push({
            status: 200,
            body: {
                recenttracks: { track: [playing({ image: [{ size: "large", "#text": "" }] })] }
            }
        });
        expect((await lastfm.readLastfmPlaying("k", "u"))?.imageUrl).toBeNull();
    });

    it("turns Last.fm's error codes into what a caller can act on", async () => {
        state.replies.push({ status: 429, body: { error: 29, message: "Rate Limit Exceeded" } });
        await expect(lastfm.readLastfmPlaying("k", "u")).rejects.toBeInstanceOf(
            lastfm.LastfmRateLimited
        );
        state.replies.push({ status: 403, body: { error: 10, message: "Invalid API key" } });
        await expect(lastfm.readLastfmPlaying("k", "u")).rejects.toBeInstanceOf(
            lastfm.LastfmKeyRefused
        );
        state.replies.push({ status: 403, body: { error: 26, message: "Suspended API key" } });
        await expect(lastfm.readLastfmPlaying("k", "u")).rejects.toBeInstanceOf(
            lastfm.LastfmKeyRefused
        );
        state.replies.push({ status: 404, body: { error: 6, message: "User not found" } });
        await expect(lastfm.readLastfmPlaying("k", "u")).rejects.toBeInstanceOf(
            lastfm.LastfmUnknownUser
        );
        state.replies.push({ status: 500, body: { error: 8, message: "Operation failed" } });
        await expect(lastfm.readLastfmPlaying("k", "u")).rejects.toThrow();
    });
});

describe("a typed username", () => {
    it("is trimmed and bounded", () => {
        expect(lastfmNameSchema.parse("  Example_User ")).toBe("Example_User");
        expect(lastfmNameSchema.safeParse("").success).toBe(false);
        expect(lastfmNameSchema.safeParse("a").success).toBe(false);
        expect(lastfmNameSchema.safeParse("has space").success).toBe(false);
        expect(lastfmNameSchema.safeParse("x".repeat(65)).success).toBe(false);
    });

    it("is the same name in any case", () => {
        expect(sameLastfmName("Example_User", " example_user")).toBe(true);
        expect(sameLastfmName("one", "two")).toBe(false);
    });
});

describe("opening a Last.fm song in Spotify", () => {
    it("is a search for the song and its artist", () => {
        expect(search.spotifySearchUrl("Song / Name", "An Artist")).toBe(
            "https://open.spotify.com/search/Song%20%2F%20Name%20An%20Artist"
        );
        expect(search.isLastfmKey("lastfm:a|b")).toBe(true);
        expect(search.isLastfmKey("4uLU6hMCjMI75M1A2tKUQC")).toBe(false);
    });
});
