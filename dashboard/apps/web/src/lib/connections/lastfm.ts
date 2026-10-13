/**
 * Last.fm: what somebody is listening to, for everybody Spotify's own API will
 * not serve.
 *
 * Spotify keeps an application in development mode to five allowlisted people,
 * and Last.fm has none of that: the person types their username, connects
 * Spotify (or any other player) to Last.fm on Last.fm's side, and the card
 * beside their name reads what Last.fm says they are playing.
 *
 * One documented method, `user.getrecenttracks`, with the deployment's API key
 * and no user authentication: https://www.last.fm/api/show/user.getRecentTracks
 * - `limit=1`, and the newest track carries `nowplaying="true"` while it plays.
 * The JSON is Last.fm's mechanical conversion of the XML
 * (https://www.last.fm/api/rest): an attribute becomes a string member, a text
 * node that also has attributes goes under `#text`, and repeated children become
 * an array - so a lone track arrives as an object. The attribute is accepted
 * both written straight on the track and under `@attr`, which is where the live
 * service puts the attributes of an element that has children. Errors are
 * `{ error, message }` with the codes listed on the method's page.
 *
 * Last.fm states no request rate in numbers (https://www.last.fm/api/tos, 4.4)
 * and answers 29 when there are too many; the poll asks each person at most once
 * per window and stops everything on a 29.
 */

import { z } from "zod";
import { LASTFM_KEY_PREFIX } from "./spotify-search";

export const LASTFM_PROVIDER = "lastfm";

/** The API root, from https://www.last.fm/api/intro, over TLS. */
const API = "https://ws.audioscrobbler.com/2.0/";

/** How long to wait on Last.fm. The poll moves on to the next person. */
const TIMEOUT_MS = 10_000;

/** A text node, bare or beside its attributes. */
const textNode = z.union([z.string(), z.object({ "#text": z.string().optional() }).passthrough()]);

/** Only the fields this reads, all of them on the method's documented sample
 *  except `image`, which the sample's ellipsis cuts off and which is read only
 *  when it is there. */
const trackSchema = z
    .object({
        name: z.string(),
        artist: textNode,
        album: textNode.optional(),
        url: z.string().optional(),
        nowplaying: z.string().optional(),
        "@attr": z.object({ nowplaying: z.string().optional() }).passthrough().optional(),
        image: z
            .array(
                z
                    .object({ size: z.string().optional(), "#text": z.string().optional() })
                    .passthrough()
            )
            .optional()
    })
    .passthrough();

const recentSchema = z.object({
    recenttracks: z.object({ track: z.unknown().optional() }).passthrough()
});

const errorSchema = z.object({ error: z.number(), message: z.string().optional() });

/** A song somebody is scrobbling right now. */
export interface LastfmTrack {
    /** Stable for the song, so the card does not count it as new on every read. */
    readonly key: string;
    readonly name: string;
    readonly artists: string;
    readonly album: string;
    readonly imageUrl: string | null;
    /** The song's page on Last.fm. */
    readonly linkUrl: string | null;
}

/** Last.fm asked for fewer requests (error 29). */
export class LastfmRateLimited extends Error {
    constructor() {
        super("Last.fm asked for fewer requests");
        this.name = "LastfmRateLimited";
    }
}

/** The deployment's key was refused: invalid (10) or suspended (26). */
export class LastfmKeyRefused extends Error {
    constructor() {
        super("Last.fm refused this deployment's API key");
        this.name = "LastfmKeyRefused";
    }
}

/** Last.fm has nobody by that name (6: the user parameter is not valid). */
export class LastfmUnknownUser extends Error {
    constructor() {
        super("Last.fm has no account with that username");
        this.name = "LastfmUnknownUser";
    }
}

function text(node: z.infer<typeof textNode> | undefined): string {
    if (node === undefined) return "";
    return (typeof node === "string" ? node : (node["#text"] ?? "")).trim();
}

function httpsUrl(value: string | undefined): string | null {
    if (!value) return null;
    try {
        return new URL(value).protocol === "https:" ? value : null;
    } catch {
        return null;
    }
}

/** The largest picture that is a real https address. Last.fm lists them small
 *  to large. */
function picture(images: z.infer<typeof trackSchema>["image"]): string | null {
    for (const image of [...(images ?? [])].reverse()) {
        const url = httpsUrl(image["#text"]);
        if (url) return url;
    }
    return null;
}

/**
 * What this Last.fm account is playing right now, or null when nothing is.
 * Throws `LastfmRateLimited`, `LastfmKeyRefused`, `LastfmUnknownUser`, or a
 * plain error for anything else (a timeout, a 5xx), which is a blip.
 */
export async function readLastfmPlaying(
    apiKey: string,
    username: string
): Promise<LastfmTrack | null> {
    const url = new URL(API);
    url.searchParams.set("method", "user.getrecenttracks");
    url.searchParams.set("user", username);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body: unknown = await response.json().catch(() => null);

    const failed = errorSchema.safeParse(body);
    if (failed.success) {
        if (failed.data.error === 29) throw new LastfmRateLimited();
        if (failed.data.error === 10 || failed.data.error === 26) throw new LastfmKeyRefused();
        if (failed.data.error === 6) throw new LastfmUnknownUser();
        throw new Error(`Last.fm refused the request (${failed.data.error})`);
    }
    if (response.status === 429) throw new LastfmRateLimited();
    if (!response.ok) throw new Error(`Last.fm answered ${response.status}`);

    const parsed = recentSchema.safeParse(body);
    if (!parsed.success) return null;
    const listed = parsed.data.recenttracks.track;
    const track = trackSchema.safeParse(Array.isArray(listed) ? listed[0] : listed);
    if (!track.success) return null;
    const one = track.data;
    if ((one["@attr"]?.nowplaying ?? one.nowplaying) !== "true") return null;

    const name = one.name.trim();
    if (!name) return null;
    const artists = text(one.artist);
    return {
        key: `${LASTFM_KEY_PREFIX}${artists.toLowerCase()}|${name.toLowerCase()}`.slice(0, 500),
        name,
        artists,
        album: text(one.album),
        imageUrl: picture(one.image),
        linkUrl: httpsUrl(one.url)
    };
}
