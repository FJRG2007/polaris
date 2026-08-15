/**
 * The links that are worth playing rather than describing.
 *
 * A video, a track or an album posted in a conversation is a thing somebody
 * wants to watch there, not a card to click through. This is the short list of
 * addresses Polaris knows how to put a player in for.
 *
 * **Nothing loads until the reader asks for it.** The card shows what Polaris
 * already knows - the title, the description, the picture it fetched itself -
 * and the player is only built when somebody presses play. That keeps the
 * existing promise: scrolling past a message does not announce the reader to
 * whoever runs the page it links to. Pressing play is a decision to be seen by
 * them, which is the same decision as opening the link, and it is the reader's
 * to make.
 *
 * A pure function over a URL, with no network and no dependency, so the same
 * answer is reached on the server and in the browser and it can be tested
 * without either.
 */

/** A player Polaris knows how to build. */
export interface Embed {
    /** Which site, for the label on the play button. */
    readonly provider: string;
    /** What goes in the frame's `src`. Built here from parts of the original
     *  address rather than taken from the page, so nothing a site says about
     *  itself decides what Polaris frames. */
    readonly url: string;
    /** Roughly how tall the player wants to be against its width. Audio players
     *  are a strip; video is a rectangle. */
    readonly shape: "video" | "audio";
}

/** Youtube's no-cookie host. It still sees the request - a frame is a request -
 *  but it does not set an advertising cookie for somebody watching one clip in a
 *  chat, and it costs nothing to prefer. */
const YOUTUBE = "https://www.youtube-nocookie.com/embed/";

/** A YouTube id: eleven characters of their alphabet, and nothing else. Matched
 *  strictly because it is being put into a URL. */
const YOUTUBE_ID = /^[\w-]{11}$/;

/** A run of digits, for the sites that number their things. */
const DIGITS = /^\d+$/;

/** Spotify's things, so an album is not framed as a track. */
const SPOTIFY_KINDS = new Set(["track", "album", "playlist", "episode", "show", "artist"]);
const SPOTIFY_ID = /^[A-Za-z0-9]{16,40}$/;

/**
 * The player for an address, or null when there is none.
 *
 * Every branch builds the frame URL from parts it has checked, never by
 * rewriting the string it was given. An id that does not look like an id is not
 * an embed - which is the difference between framing a video and framing
 * whatever somebody managed to put after the slash.
 */
export function embedFor(address: string): Embed | null {
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);

    if (host === "youtu.be") {
        const id = parts[0] ?? "";
        return YOUTUBE_ID.test(id) ? youtube(id, url) : null;
    }

    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
        // The three shapes a video address comes in: a watch link, a share
        // link, and a short.
        const id =
            url.searchParams.get("v") ??
            (parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live"
                ? (parts[1] ?? "")
                : "");
        return YOUTUBE_ID.test(id) ? youtube(id, url) : null;
    }

    if (host === "vimeo.com" || host === "player.vimeo.com") {
        const id = parts.find((part) => DIGITS.test(part)) ?? "";
        return id
            ? { provider: "Vimeo", url: `https://player.vimeo.com/video/${id}`, shape: "video" }
            : null;
    }

    if (host === "open.spotify.com") {
        // An address may be localised: /intl-es/track/<id>.
        const at = parts.findIndex((part) => SPOTIFY_KINDS.has(part));
        const kind = at === -1 ? "" : parts[at]!;
        const id = at === -1 ? "" : (parts[at + 1] ?? "");
        if (!kind || !SPOTIFY_ID.test(id)) return null;
        return {
            provider: "Spotify",
            url: `https://open.spotify.com/embed/${kind}/${id}`,
            shape: kind === "track" || kind === "episode" ? "audio" : "video"
        };
    }

    return null;
}

/**
 * Where to ask a site what one of its links is, when the page itself will not
 * say.
 *
 * YouTube, and most sites with a player, hand a plain fetch a consent wall or a
 * script and nothing else - so the ordinary look at the page comes back with no
 * title, no description and no picture, and the link gets no card. Each of these
 * publishes the same answer over oEmbed, openly and with no account, key or
 * quota behind it.
 *
 * The address is only ever passed as a query parameter to the provider's own
 * fixed host, so this reaches nowhere the caller chooses.
 */
export function oembedFor(address: string): string | null {
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        return null;
    }
    const host = url.hostname.replace(/^www\./, "").toLowerCase();

    const endpoint =
        host === "youtu.be" || host.endsWith("youtube.com")
            ? "https://www.youtube.com/oembed"
            : host === "vimeo.com" || host === "player.vimeo.com"
              ? "https://vimeo.com/api/oembed.json"
              : host === "open.spotify.com"
                ? "https://open.spotify.com/oembed"
                : null;
    if (!endpoint) return null;

    const asked = new URL(endpoint);
    asked.searchParams.set("url", url.href);
    asked.searchParams.set("format", "json");
    return asked.href;
}

/** A YouTube player, keeping the start time when the address carried one - a
 *  link posted at a moment was posted at that moment on purpose. */
function youtube(id: string, url: URL): Embed {
    const at = url.searchParams.get("t") ?? url.searchParams.get("start") ?? "";
    const seconds = /^\d+$/.exec(at.replace(/s$/, ""))?.[0];
    return {
        provider: "YouTube",
        url: seconds ? `${YOUTUBE}${id}?start=${seconds}` : `${YOUTUBE}${id}`,
        shape: "video"
    };
}
