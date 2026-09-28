/**
 * Spotify accounts, for showing what somebody is listening to and for listening
 * along with them.
 *
 * Ordinary OAuth on an application the operator registers in Spotify's developer
 * dashboard. Three scopes, all about playback and nothing else: reading what is
 * playing (`user-read-currently-playing`, `user-read-playback-state`) and
 * starting, seeking and pausing it for "Listen along" (`user-modify-playback-
 * state`). Nothing here reads a library, a playlist or an address.
 *
 * The grant is kept, encrypted by the connection store, because both uses are
 * questions asked later: what is playing changes every few minutes. Spotify's
 * access tokens last an hour, so the refresh token is kept with it and spent on
 * the way past; a refresh answer may or may not carry a new refresh token, and
 * the old one stays good when it does not.
 *
 * Two things about Spotify that the rest of this code relies on and that are
 * easy to forget:
 *
 * - **Controlling playback needs Premium.** Spotify refuses play, seek and pause
 *   for a free account with 403, and says nothing about it until then - the
 *   profile no longer carries the plan. The refusal is turned into a sentence
 *   here (`playerRefusal`) rather than left as a status code.
 * - **It plays on a device that is on.** With no Spotify app open anywhere, a
 *   play request answers 404; the sentence says to open one.
 */

import { z } from "zod";
import { refusalMessage } from "./refusal";
import { oauthClientFor } from "./oauth-app";
import type { ConnectionCredential } from "./store";

export const SPOTIFY_PROVIDER = "spotify";

const AUTHORIZE = "https://accounts.spotify.com/authorize";
const TOKEN = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";

const SCOPES = ["user-read-currently-playing", "user-read-playback-state", "user-modify-playback-state"];

/** What a link has to carry to be worth anything, so one granted before this
 *  list grew is spotted and its owner asked to authorize again. */
export const SPOTIFY_REQUIRED_SCOPES: readonly string[] = SCOPES;

/** Spent this far before expiry rather than exactly at it. */
const REFRESH_MARGIN_MS = 60_000;

/** How long to wait on Spotify. The poll moves on to the next account. */
const TIMEOUT_MS = 10_000;

export interface SpotifyOAuthClient {
    readonly clientId: string;
    readonly clientSecret: string;
}

/** The application an operator registered, or null when this deployment has none. */
export function getSpotifyOAuthClient(): Promise<SpotifyOAuthClient | null> {
    return oauthClientFor(SPOTIFY_PROVIDER);
}

/**
 * Where to send somebody to authorize.
 *
 * `show_dialog=true` so the consent screen is shown even to an account that
 * authorized this application before: somebody linking should see whose Spotify
 * is about to be linked rather than be bounced back as whoever the browser was
 * signed into.
 */
export function spotifyAuthorizeUrl(
    client: SpotifyOAuthClient,
    redirectUri: string,
    state: string
): string {
    const url = new URL(AUTHORIZE);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("show_dialog", "true");
    return url.toString();
}

const tokenSchema = z.object({
    access_token: z.string().min(1),
    expires_in: z.number().optional(),
    refresh_token: z.string().optional(),
    scope: z.string().optional()
});

/** Only the fields this reads. The profile has lost its address and plan in
 *  Spotify's own changes, and what is left is the id and the name. */
const userSchema = z.object({
    id: z.string().min(1),
    display_name: z.string().nullish(),
    images: z.array(z.object({ url: z.string().url() })).nullish()
});

export interface SpotifyAuthorization {
    readonly accountId: string;
    readonly label: string;
    readonly avatarUrl: string | null;
    readonly email: null;
    readonly scope: string;
    readonly credential: ConnectionCredential;
}

/** Spend a grant. Spotify takes the application's credentials as Basic auth. */
async function postToken(
    client: SpotifyOAuthClient,
    grant: Record<string, string>
): Promise<z.infer<typeof tokenSchema>> {
    const response = await fetch(TOKEN, {
        method: "POST",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`
        },
        body: new URLSearchParams(grant),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) {
        if (grant.grant_type === "refresh_token") {
            if (response.status === 429) throw new SpotifyRateLimited(retryAfter(response));
            if (response.status === 400 || response.status === 401) throw new SpotifyUnauthorized();
        }
        throw new Error(await refusalMessage(response, "Spotify refused the token request"));
    }
    return tokenSchema.parse(await response.json());
}

function credentialFrom(
    token: z.infer<typeof tokenSchema>,
    previous?: ConnectionCredential
): ConnectionCredential {
    const refreshToken = token.refresh_token ?? previous?.refreshToken;
    return {
        accessToken: token.access_token,
        ...(refreshToken ? { refreshToken } : {}),
        ...(token.expires_in ? { expiresAt: Date.now() + token.expires_in * 1000 } : {})
    };
}

/** Spend the code and read back who authorized. */
export async function exchangeSpotifyCode(
    client: SpotifyOAuthClient,
    code: string,
    redirectUri: string
): Promise<SpotifyAuthorization> {
    const token = await postToken(client, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri
    });
    const response = await fetch(`${API}/me`, {
        headers: { authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) {
        throw new Error(await refusalMessage(response, "Spotify would not say which account authorized"));
    }
    const user = userSchema.parse(await response.json());
    return {
        accountId: user.id,
        label: user.display_name?.trim() || user.id,
        avatarUrl: user.images?.[0]?.url ?? null,
        // Spotify no longer hands over an address, and would not be taken as
        // proof of one anyway.
        email: null,
        scope: token.scope ?? SCOPES.join(" "),
        credential: credentialFrom(token)
    };
}

/** Whose account a sign-in's code belongs to. Never offered as a way in, but the
 *  adapter interface asks every provider for it. */
export async function identifySpotifyAccount(
    client: SpotifyOAuthClient,
    code: string,
    redirectUri: string
): Promise<{ accountId: string }> {
    const { accountId } = await exchangeSpotifyCode(client, code, redirectUri);
    return { accountId };
}

/**
 * An access token for this link that is good right now, and the credential to
 * write back when it had to be refreshed. Null when there is nothing to refresh
 * with, which is a link that has to be made again. A refresh Spotify refuses
 * throws `SpotifyUnauthorized`, a 429 `SpotifyRateLimited`, and anything else -
 * a timeout, a 5xx - a plain error, which is a blip and not a revoked link.
 */
export async function spotifyAccessToken(
    client: SpotifyOAuthClient,
    credential: ConnectionCredential
): Promise<{ accessToken: string; refreshed: ConnectionCredential | null } | null> {
    const fresh = credential.expiresAt === undefined || credential.expiresAt - REFRESH_MARGIN_MS > Date.now();
    if (credential.accessToken && fresh) return { accessToken: credential.accessToken, refreshed: null };
    if (!credential.refreshToken) return null;
    const token = await postToken(client, {
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken
    });
    return { accessToken: token.access_token, refreshed: credentialFrom(token, credential) };
}

/** Spotify asked to be left alone, for this long. */
export class SpotifyRateLimited extends Error {
    constructor(readonly retryAfterMs: number) {
        super("Spotify asked for fewer requests");
        this.name = "SpotifyRateLimited";
    }
}

/** The token was refused: revoked, or the application's access removed. */
export class SpotifyUnauthorized extends Error {
    constructor() {
        super("Spotify no longer accepts this link");
        this.name = "SpotifyUnauthorized";
    }
}

function retryAfter(response: Response): number {
    const seconds = Number(response.headers.get("retry-after"));
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000;
}

const imageSchema = z.object({
    url: z.string().url(),
    width: z.number().nullish(),
    height: z.number().nullish()
});

const playingSchema = z.object({
    is_playing: z.boolean(),
    progress_ms: z.number().nullish(),
    currently_playing_type: z.string().optional(),
    item: z
        .object({
            id: z.string().nullish(),
            uri: z.string(),
            name: z.string(),
            duration_ms: z.number(),
            artists: z.array(z.object({ name: z.string() })).default([]),
            album: z
                .object({ name: z.string().optional(), images: z.array(imageSchema).default([]) })
                .optional(),
            external_urls: z.object({ spotify: z.string().url().optional() }).optional(),
            is_local: z.boolean().optional()
        })
        .nullish()
});

/** A track somebody is listening to right now. */
export interface SpotifyTrack {
    readonly id: string;
    readonly uri: string;
    readonly name: string;
    readonly artists: string;
    readonly album: string;
    readonly imageUrl: string | null;
    readonly linkUrl: string | null;
    readonly durationMs: number;
    readonly progressMs: number;
}

/** The size of cover picked for a card: the smallest at least this wide. */
const COVER_WIDTH = 160;

function cover(images: readonly z.infer<typeof imageSchema>[]): string | null {
    const sized = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
    return (sized.find((image) => (image.width ?? 0) >= COVER_WIDTH) ?? sized.at(-1))?.url ?? null;
}

/**
 * What is playing on this account, or null when nothing is.
 *
 * Paused is nothing, as it is where this is shown elsewhere: a card saying
 * somebody is listening to a song they stopped an hour ago is not true. So are a
 * podcast, an advert and a file on their own disk - a card with a Listen along
 * button for something nobody else can play would be a button that fails.
 */
export async function readSpotifyPlaying(accessToken: string): Promise<SpotifyTrack | null> {
    const response = await fetch(`${API}/me/player/currently-playing`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (response.status === 204) return null;
    if (response.status === 429) throw new SpotifyRateLimited(retryAfter(response));
    if (response.status === 401) throw new SpotifyUnauthorized();
    if (!response.ok) throw new Error(await refusalMessage(response, "Spotify would not say what is playing"));
    const text = await response.text();
    if (!text.trim()) return null;
    const parsed = playingSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    const { item, is_playing: playing } = parsed.data;
    if (!playing || !item || !item.id || item.is_local) return null;
    if ((parsed.data.currently_playing_type ?? "track") !== "track") return null;
    return {
        id: item.id,
        uri: item.uri,
        name: item.name,
        artists: item.artists.map((artist) => artist.name).join(", "),
        album: item.album?.name ?? "",
        imageUrl: cover(item.album?.images ?? []),
        linkUrl: item.external_urls?.spotify ?? null,
        durationMs: item.duration_ms,
        progressMs: Math.max(0, parsed.data.progress_ms ?? 0)
    };
}

/** Why Spotify would not play something for somebody, as a sentence for them. */
export class SpotifyPlayerRefusal extends Error {
    constructor(
        readonly kind: "premium" | "device" | "other",
        message: string
    ) {
        super(message);
        this.name = "SpotifyPlayerRefusal";
    }
}

const PREMIUM_SENTENCE =
    "Listening along needs Spotify Premium. Spotify does not let anything else control playback on a free account.";
const DEVICE_SENTENCE =
    "Open Spotify on your phone or computer and play anything for a second, then try again. Spotify only plays on a device that is on.";

const playerErrorSchema = z.object({
    error: z.object({ status: z.number().optional(), message: z.string().optional(), reason: z.string().optional() })
});

/** Turn a refused player request into the sentence its owner is shown. */
export async function playerRefusal(response: Response): Promise<SpotifyPlayerRefusal> {
    let reason = "";
    let message = "";
    try {
        const parsed = playerErrorSchema.safeParse(await response.json());
        if (parsed.success) {
            reason = parsed.data.error.reason ?? "";
            message = parsed.data.error.message ?? "";
        }
    } catch {
        // No body worth reading; the status decides.
    }
    if (reason === "PREMIUM_REQUIRED" || /premium/i.test(message)) {
        return new SpotifyPlayerRefusal("premium", PREMIUM_SENTENCE);
    }
    if (response.status === 404 || reason === "NO_ACTIVE_DEVICE") {
        return new SpotifyPlayerRefusal("device", DEVICE_SENTENCE);
    }
    // A 403 with no reason is, in practice, the free-account refusal worded
    // differently; nothing else a playback request can be forbidden for applies
    // to somebody's own account.
    if (response.status === 403) return new SpotifyPlayerRefusal("premium", PREMIUM_SENTENCE);
    return new SpotifyPlayerRefusal("other", "Spotify would not play it. Try again in a moment.");
}

/** Play one track from a position on the account's active device. */
export async function spotifyPlay(accessToken: string, uri: string, positionMs: number): Promise<void> {
    const response = await fetch(`${API}/me/player/play`, {
        method: "PUT",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ uris: [uri], position_ms: Math.max(0, Math.round(positionMs)) }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (response.ok) return;
    if (response.status === 429) throw new SpotifyRateLimited(retryAfter(response));
    if (response.status === 401) throw new SpotifyUnauthorized();
    throw await playerRefusal(response);
}

/** Pause the account's active device. Nothing playing is not a failure. */
export async function spotifyPause(accessToken: string): Promise<void> {
    const response = await fetch(`${API}/me/player/pause`, {
        method: "PUT",
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (response.ok || response.status === 404) return;
    if (response.status === 429) throw new SpotifyRateLimited(retryAfter(response));
    if (response.status === 401) throw new SpotifyUnauthorized();
    // Already paused answers 403 on some clients; that is the state wanted.
    if (response.status === 403) return;
    throw await playerRefusal(response);
}
