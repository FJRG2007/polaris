/**
 * Talking to Spotify: linking an account, reading what it plays, and playing
 * something on it.
 *
 * What is pinned:
 * - the consent screen asks for the three playback scopes and nothing else, and
 *   is always shown, so nobody links whoever their browser happened to be;
 * - a Spotify account is never a way in unless somebody decides it should be;
 * - a paused track, a podcast, an advert and a file on somebody's own disk are
 *   all "nothing playing" - a card with a Listen along button for something
 *   nobody else can play would be a button that fails;
 * - a refresh answer without a new refresh token keeps the old one, or the link
 *   dies an hour later;
 * - Spotify's refusals become the sentence somebody can act on: Premium, or no
 *   device open, and a 429 carries how long to wait.
 */

import { findConnectionProvider } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
    responses: [] as Array<{ status: number; body?: unknown; headers?: Record<string, string> }>,
    requests: [] as Array<{ url: string; method: string; body?: string; headers: Record<string, string> }>
};

vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => ({ enabled: true, config: { clientId: "client-id" } }),
    getIntegrationSecret: async () => "client-secret"
}));

vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const next = state.responses.shift();
    if (!next) throw new Error(`no reply queued for ${String(input)}`);
    state.requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body === undefined ? undefined : String(init.body),
        headers: (init?.headers as Record<string, string>) ?? {}
    });
    const text = next.body === undefined ? "" : JSON.stringify(next.body);
    return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        headers: new Headers(next.headers ?? {}),
        json: async () => (next.body === undefined ? Promise.reject(new Error("empty")) : next.body),
        text: async () => text
    } as Response;
});

const spotify = await import("@/lib/connections/spotify");

const CLIENT = { clientId: "client-id", clientSecret: "client-secret" };

function track(overrides: Record<string, unknown> = {}) {
    return {
        is_playing: true,
        progress_ms: 30_000,
        currently_playing_type: "track",
        item: {
            id: "track1",
            uri: "spotify:track:track1",
            name: "Song",
            duration_ms: 200_000,
            artists: [{ name: "Ana" }, { name: "Bea" }],
            album: {
                name: "Album",
                images: [
                    { url: "https://i.scdn.co/image/big", width: 640, height: 640 },
                    { url: "https://i.scdn.co/image/small", width: 64, height: 64 },
                    { url: "https://i.scdn.co/image/mid", width: 300, height: 300 }
                ]
            },
            external_urls: { spotify: "https://open.spotify.com/track/track1" },
            is_local: false
        },
        ...overrides
    };
}

beforeEach(() => {
    state.responses = [];
    state.requests = [];
});

describe("linking an account", () => {
    it("asks for playback and nothing else, and always shows the consent screen", () => {
        const url = new URL(spotify.spotifyAuthorizeUrl(CLIENT, "https://polaris.example/cb", "state1"));
        expect(url.origin + url.pathname).toBe("https://accounts.spotify.com/authorize");
        expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual([
            "user-modify-playback-state",
            "user-read-currently-playing",
            "user-read-playback-state"
        ]);
        expect(url.searchParams.get("show_dialog")).toBe("true");
        expect(url.searchParams.get("state")).toBe("state1");
        expect(url.searchParams.get("redirect_uri")).toBe("https://polaris.example/cb");
    });

    it("is never a way in unless somebody decides it should be", () => {
        const provider = findConnectionProvider("spotify");
        expect(provider?.signInDefault).toBe(false);
        expect(provider?.signInWarning).toBeTruthy();
        expect(provider?.acceptsToken).toBe(false);
    });

    it("spends the code with the application's own credentials and reads the name", async () => {
        state.responses.push(
            { status: 200, body: { access_token: "a1", refresh_token: "r1", expires_in: 3600, scope: "x y" } },
            { status: 200, body: { id: "ana-id", display_name: "Ana", images: [{ url: "https://i.scdn.co/me" }] } }
        );
        const linked = await spotify.exchangeSpotifyCode(CLIENT, "code1", "https://polaris.example/cb");
        expect(linked).toMatchObject({ accountId: "ana-id", label: "Ana", avatarUrl: "https://i.scdn.co/me", email: null });
        expect(linked.credential).toMatchObject({ accessToken: "a1", refreshToken: "r1" });
        const token = state.requests[0]!;
        expect(token.headers.authorization).toBe(`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);
        expect(token.body).toContain("grant_type=authorization_code");
    });

    it("keeps the old refresh token when a refresh hands back none", async () => {
        state.responses.push({ status: 200, body: { access_token: "a2", expires_in: 3600 } });
        const got = await spotify.spotifyAccessToken(CLIENT, { accessToken: "old", refreshToken: "r1", expiresAt: 0 });
        expect(got?.accessToken).toBe("a2");
        expect(got?.refreshed).toMatchObject({ accessToken: "a2", refreshToken: "r1" });
    });

    it("does not refresh a token that is still good", async () => {
        const got = await spotify.spotifyAccessToken(CLIENT, {
            accessToken: "live",
            refreshToken: "r1",
            expiresAt: Date.now() + 30 * 60_000
        });
        expect(got).toEqual({ accessToken: "live", refreshed: null });
        expect(state.requests).toHaveLength(0);
    });
});

describe("what is playing", () => {
    it("is a track, with a cover of a sensible size", async () => {
        state.responses.push({ status: 200, body: track() });
        expect(await spotify.readSpotifyPlaying("t")).toEqual({
            id: "track1",
            uri: "spotify:track:track1",
            name: "Song",
            artists: "Ana, Bea",
            album: "Album",
            imageUrl: "https://i.scdn.co/image/mid",
            linkUrl: "https://open.spotify.com/track/track1",
            durationMs: 200_000,
            progressMs: 30_000
        });
    });

    it("is nothing when paused, a podcast, an advert, or a file on their own disk", async () => {
        state.responses.push(
            { status: 204 },
            { status: 200, body: track({ is_playing: false }) },
            { status: 200, body: track({ currently_playing_type: "episode" }) },
            { status: 200, body: track({ currently_playing_type: "ad", item: null }) },
            { status: 200, body: track({ item: { ...track().item, id: null, is_local: true } }) }
        );
        for (let index = 0; index < 5; index += 1) expect(await spotify.readSpotifyPlaying("t")).toBeNull();
    });

    it("says how long Spotify asked to be left alone", async () => {
        state.responses.push({ status: 429, headers: { "retry-after": "12" } });
        await expect(spotify.readSpotifyPlaying("t")).rejects.toMatchObject({ retryAfterMs: 12_000 });
    });

    it("tells a revoked link apart from any other failure", async () => {
        state.responses.push({ status: 401 });
        await expect(spotify.readSpotifyPlaying("t")).rejects.toBeInstanceOf(spotify.SpotifyUnauthorized);
    });
});

describe("playing something", () => {
    it("puts the one track on at the position asked", async () => {
        state.responses.push({ status: 204 });
        await spotify.spotifyPlay("t", "spotify:track:x", 12_345.6);
        expect(state.requests[0]).toMatchObject({ method: "PUT", url: "https://api.spotify.com/v1/me/player/play" });
        expect(JSON.parse(state.requests[0]!.body!)).toEqual({ uris: ["spotify:track:x"], position_ms: 12_346 });
    });

    it("says Premium when Spotify refuses a free account", async () => {
        state.responses.push({ status: 403, body: { error: { status: 403, reason: "PREMIUM_REQUIRED" } } });
        await expect(spotify.spotifyPlay("t", "u", 0)).rejects.toMatchObject({ kind: "premium" });
        state.responses.push({ status: 403 });
        await expect(spotify.spotifyPlay("t", "u", 0)).rejects.toMatchObject({
            message: expect.stringContaining("Premium")
        });
    });

    it("says to open Spotify somewhere when no device is on", async () => {
        state.responses.push({ status: 404, body: { error: { status: 404, reason: "NO_ACTIVE_DEVICE" } } });
        await expect(spotify.spotifyPlay("t", "u", 0)).rejects.toMatchObject({
            kind: "device",
            message: expect.stringContaining("Open Spotify")
        });
    });
});
