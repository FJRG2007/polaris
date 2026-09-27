/**
 * The links that are worth playing rather than describing.
 *
 * A video, a track, a clip or a post posted in a conversation is a thing
 * somebody wants to watch there, not a card to click through. This is the short
 * list of addresses Polaris knows how to put a player in for - the same sites a
 * chat app is expected to play inline.
 *
 * **Nothing loads until the reader asks for it.** The card shows what Polaris
 * already knows - the title, the description, the picture it fetched itself -
 * and the player is only built when somebody presses play. That keeps the
 * existing promise: scrolling past a message does not announce the reader to
 * whoever runs the page it links to. Pressing play is a decision to be seen by
 * them, which is the same decision as opening the link, and it is the reader's
 * to make. It is also why a conversation full of links costs nothing: thirty
 * links are thirty pictures, not thirty players.
 *
 * A pure function over a URL, with no network and no dependency, so the same
 * answer is reached on the server and in the browser and it can be tested
 * without either.
 *
 * What is deliberately *not* here: the short links a site hands out from its
 * share button (`vm.tiktok.com`, `on.soundcloud.com`, `redd.it`, Reddit's
 * `/s/` links). They name nothing on their own - the thing they point at is only
 * known by following the redirect, and a player is never built from somewhere
 * Polaris has not checked. Those get the ordinary card, which is still correct.
 */

/**
 * How much room a player takes, reserved before it exists so pressing play does
 * not move the conversation.
 *
 * - `video`: a landscape rectangle, 16:9.
 * - `portrait`: a phone-shaped 9:16 player - a TikTok, a Short.
 * - `post`: a tall panel for something that is a post rather than a player, and
 *   whose height is decided by the post - X, Reddit, Instagram, a playlist.
 * - `audio`: a strip, for one track or one episode.
 */
export type EmbedShape = "video" | "portrait" | "post" | "audio";

/** A player Polaris knows how to build. */
export interface Embed {
    /** Which site, for the label on the play button. */
    readonly provider: string;
    /** What goes in the frame's `src`. Built here from parts of the original
     *  address rather than taken from the page, so nothing a site says about
     *  itself decides what Polaris frames. */
    readonly url: string;
    readonly shape: EmbedShape;
    /** The parameter that makes this site's player start on its own, or null
     *  for a site that has none. Each site spells it differently, and a
     *  parameter a player does not know is at best ignored. */
    readonly start: string | null;
    /** Twitch refuses to play inside a page unless it is told, in the address,
     *  which site it is being shown on. That is only known in the browser. It
     *  also refuses any page not served over HTTPS (localhost aside), so a
     *  Polaris reached by a LAN address over plain HTTP shows the card instead
     *  of a player that could only ever say no. */
    readonly needsParent: boolean;
}

/** Youtube's no-cookie host. It still sees the request - a frame is a request -
 *  but it does not set an advertising cookie for somebody watching one clip in a
 *  chat, and it costs nothing to prefer. */
const YOUTUBE = "https://www.youtube-nocookie.com/embed/";

/** A YouTube id: eleven characters of their alphabet, and nothing else. Matched
 *  strictly because it is being put into a URL. */
const YOUTUBE_ID = /^[\w-]{11}$/;

/** A run of digits, for the sites that number their things. */
const DIGITS = /^\d{1,20}$/;

/** Spotify's things, so an album is not framed as a track. */
const SPOTIFY_KINDS = new Set(["track", "album", "playlist", "episode", "show", "artist"]);
const SPOTIFY_ID = /^[A-Za-z0-9]{16,40}$/;

/** Vimeo's unlisted videos carry a second, hexadecimal key after the number. */
const VIMEO_HASH = /^[0-9a-f]{6,20}$/;

/** A TikTok video is a long number - nineteen digits today. */
const TIKTOK_ID = /^\d{15,25}$/;

/** An Instagram shortcode. Eleven characters for a public post, longer for some
 *  others; always this alphabet. */
const INSTAGRAM_CODE = /^[\w-]{5,64}$/;

/** A Twitch login name, a clip's slug. */
const TWITCH_LOGIN = /^[A-Za-z0-9_]{3,25}$/;
const TWITCH_CLIP = /^[\w-]{4,100}$/;

/** The first path segments on twitch.tv that are pages of Twitch's own, not
 *  somebody's channel - `twitch.tv/directory` is not a stream. */
const TWITCH_PAGES = new Set([
    "directory",
    "videos",
    "settings",
    "downloads",
    "jobs",
    "search",
    "login",
    "signup",
    "subscriptions",
    "inventory",
    "wallet",
    "friends",
    "messages",
    "drops",
    "turbo",
    "prime",
    "store",
    "moderator",
    "popout",
    "broadcast",
    "bits",
    "dashboard",
    "following",
    "privacy",
    "legal",
    "team",
    "event",
    "collections",
    "products",
    "embed",
    "subs",
    "p",
    "u"
]);

/** A SoundCloud account or track slug, and the key a private link carries. */
const SOUNDCLOUD_SLUG = /^[\w-]{1,100}$/;
const SOUNDCLOUD_SECRET = /^s-[A-Za-z0-9]{4,20}$/;

/** First segments on soundcloud.com that are SoundCloud's own pages. */
const SOUNDCLOUD_PAGES = new Set([
    "discover",
    "stream",
    "search",
    "upload",
    "you",
    "charts",
    "pages",
    "settings",
    "messages",
    "notifications",
    "people",
    "tags",
    "terms-of-use",
    "jobs",
    "mobile",
    "popular",
    "imprint",
    "creators",
    "connect",
    "signin",
    "signup",
    "logout",
    "feed"
]);

/** Second segments that are a tab of somebody's profile rather than a track -
 *  `soundcloud.com/someone/likes` is a list, not a thing to play. */
const SOUNDCLOUD_TABS = new Set([
    "tracks",
    "albums",
    "sets",
    "reposts",
    "likes",
    "followers",
    "following",
    "popular-tracks",
    "comments",
    "spotlight"
]);

/** A subreddit name and a post id, as Reddit writes them. */
const SUBREDDIT = /^[A-Za-z0-9_]{2,21}$/;
const REDDIT_POST = /^[a-z0-9]{3,10}$/;

/** A Streamable video's code, and the handful of Streamable's own pages that
 *  would otherwise look like one. */
const STREAMABLE_CODE = /^[A-Za-z0-9]{4,12}$/;
const STREAMABLE_PAGES = new Set([
    "login",
    "signup",
    "pricing",
    "upload",
    "about",
    "blog",
    "terms",
    "privacy",
    "help",
    "settings",
    "documentation",
    "careers",
    "clipper",
    "videos"
]);

/** A Dailymotion id always starts with an x. */
const DAILYMOTION_ID = /^x[A-Za-z0-9]{3,12}$/;

/**
 * The player for an address, or null when there is none.
 *
 * Every branch builds the frame URL from parts it has checked, never by
 * rewriting the string it was given. An id that does not look like an id is not
 * an embed - which is the difference between framing a video and framing
 * whatever somebody managed to put after the slash. Hostnames are compared
 * whole, so `youtube.com.evil.example` is nobody's player.
 */
export function embedFor(address: string): Embed | null {
    const url = parsed(address);
    if (!url) return null;

    const host = hostOf(url);
    const parts = url.pathname.split("/").filter(Boolean);

    switch (host) {
        case "youtu.be":
            return youtube(parts[0] ?? "", url, false);
        case "youtube.com":
        case "m.youtube.com":
        case "music.youtube.com":
        case "youtube-nocookie.com":
            return youtubeOn(parts, url);
        case "vimeo.com":
        case "player.vimeo.com":
            return vimeo(parts, url);
        case "open.spotify.com":
            return spotify(parts);
        case "tiktok.com":
        case "m.tiktok.com":
            return tiktok(parts);
        case "instagram.com":
        case "m.instagram.com":
        case "instagr.am":
            return instagram(parts);
        case "x.com":
        case "twitter.com":
        case "mobile.x.com":
        case "mobile.twitter.com":
            return post(parts);
        case "twitch.tv":
        case "m.twitch.tv":
            return twitch(parts);
        case "clips.twitch.tv":
            return twitchClip(
                parts[0] === "embed" ? (url.searchParams.get("clip") ?? "") : (parts[0] ?? "")
            );
        case "soundcloud.com":
        case "m.soundcloud.com":
            return soundcloud(parts);
        case "reddit.com":
        case "old.reddit.com":
        case "new.reddit.com":
        case "np.reddit.com":
        case "m.reddit.com":
            return reddit(parts);
        case "streamable.com":
            return streamable(parts);
        case "dailymotion.com":
        case "geo.dailymotion.com":
            return dailymotion(parts, url);
        case "dai.ly":
            return dailymotionVideo(parts[0] ?? "");
        default:
            return null;
    }
}

/**
 * The address a frame is actually given once somebody has pressed play.
 *
 * The frame does not exist until then, so it is built already running rather
 * than handing over a second play button to press. The press that has already
 * happened is also what lets a site play with the sound on - a player built
 * without one is muted by the browser, which is the other half of why this is
 * added here and never stored.
 *
 * `pageHost` is the hostname Polaris is being read on, for the one site
 * (Twitch) that will not play without being told it. It goes into a query
 * parameter, so it is checked to be a hostname first; anything else is left out
 * and Twitch shows its own refusal instead.
 */
export function playerAddress(embed: Embed, pageHost: string): string {
    const extra: string[] = [];
    if (embed.start) extra.push(embed.start);
    const host = pageHost.toLowerCase();
    if (embed.needsParent && /^[a-z0-9.-]{1,253}$/.test(host)) extra.push(`parent=${host}`);
    if (extra.length === 0) return embed.url;
    return `${embed.url}${embed.url.includes("?") ? "&" : "?"}${extra.join("&")}`;
}

/**
 * Where to ask a site what one of its links is, when the page itself will not
 * say.
 *
 * YouTube, and most sites with a player, hand a plain fetch a consent wall or a
 * script and nothing else - so the ordinary look at the page comes back with no
 * title, no description and no picture, and the link gets no card. Each of these
 * publishes the same answer over oEmbed, openly and with no account, key or
 * quota behind it. (Instagram's and Twitch's need an app token, and X's answer
 * has no title in it, so those three are left to the page.)
 *
 * The address is only ever passed as a query parameter to the provider's own
 * fixed host, so this reaches nowhere the caller chooses.
 */
export function oembedFor(address: string): string | null {
    const url = parsed(address);
    if (!url) return null;
    const host = hostOf(url);

    const endpoint =
        host === "youtu.be" || host.endsWith("youtube.com")
            ? "https://www.youtube.com/oembed"
            : host === "vimeo.com" || host === "player.vimeo.com"
              ? "https://vimeo.com/api/oembed.json"
              : host === "open.spotify.com"
                ? "https://open.spotify.com/oembed"
                : host === "tiktok.com" || host === "m.tiktok.com"
                  ? "https://www.tiktok.com/oembed"
                  : host === "soundcloud.com" || host === "m.soundcloud.com"
                    ? "https://soundcloud.com/oembed"
                    : host === "reddit.com" || host.endsWith(".reddit.com")
                      ? "https://www.reddit.com/oembed"
                      : host === "streamable.com"
                        ? "https://api.streamable.com/oembed.json"
                        : host === "dailymotion.com" ||
                            host === "dai.ly" ||
                            host === "geo.dailymotion.com"
                          ? "https://www.dailymotion.com/services/oembed"
                          : null;
    if (!endpoint) return null;

    const asked = new URL(endpoint);
    asked.searchParams.set(
        "url",
        asked.hostname === "www.dailymotion.com" ? dailymotionPage(url) : url.href
    );
    asked.searchParams.set("format", "json");
    return asked.href;
}

/**
 * The one address Dailymotion's oEmbed is sure to understand for a video: its
 * page. A link to the newer player (`geo.dailymotion.com/player.html?video=`) is
 * not a page, and asking about it as-is gets no title and no picture.
 */
function dailymotionPage(url: URL): string {
    const embed = embedFor(url.href);
    const id = embed ? embed.url.split("/").pop() : null;
    return id ? `https://www.dailymotion.com/video/${id}` : url.href;
}

/** A web address, or null for anything else - a scheme that is not the web is
 *  not something to frame or to ask about. */
function parsed(address: string): URL | null {
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        return null;
    }
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

/** The hostname, without the `www.` every site answers on as well. */
function hostOf(url: URL): string {
    return url.hostname.toLowerCase().replace(/^www\./, "");
}

/** The shapes a YouTube address comes in on its own hosts: a watch link, an
 *  embed, a Short, a live stream, and the old `/v/` form. */
function youtubeOn(parts: string[], url: URL): Embed | null {
    const watched = url.searchParams.get("v");
    if (watched !== null) return youtube(watched, url, false);
    const [kind, id = ""] = parts;
    if (kind === "shorts") return youtube(id, url, true);
    if (kind === "embed" || kind === "live" || kind === "v") return youtube(id, url, false);
    return null;
}

/** A YouTube player, keeping the start time when the address carried one - a
 *  link posted at a moment was posted at that moment on purpose. A Short is
 *  framed upright, the way it was filmed. */
function youtube(id: string, url: URL, short: boolean): Embed | null {
    if (!YOUTUBE_ID.test(id)) return null;
    const seconds = secondsOf(url.searchParams.get("t") ?? url.searchParams.get("start") ?? "");
    return {
        provider: "YouTube",
        url: seconds ? `${YOUTUBE}${id}?start=${seconds}` : `${YOUTUBE}${id}`,
        shape: short ? "portrait" : "video",
        start: "autoplay=1",
        needsParent: false
    };
}

/** A YouTube time in either spelling - `86`, `86s` or `1m26s` - as seconds, or
 *  null when it is neither. */
function secondsOf(at: string): number | null {
    if (/^\d{1,6}s?$/.test(at)) return Number.parseInt(at, 10) || null;
    const match = /^(?:(\d{1,3})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s)?$/.exec(at);
    if (!match || !at) return null;
    const [, h = "0", m = "0", s = "0"] = match;
    return Number(h) * 3600 + Number(m) * 60 + Number(s) || null;
}

/**
 * A Vimeo video in any of the places Vimeo shows one: on its own, inside a
 * channel, a group, an album or a showcase, or as the player itself. Only the
 * number *in the video's position* is taken, so a showcase's own number is not
 * mistaken for a video.
 *
 * `dnt=1` is Vimeo's equivalent of YouTube's no-cookie host: the player does
 * not track the session.
 */
function vimeo(parts: string[], url: URL): Embed | null {
    let id = "";
    let hash = url.searchParams.get("h") ?? "";
    const [first = "", second = "", third = "", fourth = ""] = parts;
    if (first === "video") {
        id = second;
    } else if (DIGITS.test(first)) {
        id = first;
        hash = second || hash;
    } else if (first === "channels" && parts.length === 3) {
        id = third;
    } else if (
        (first === "groups" && third === "videos") ||
        ((first === "album" || first === "showcase") && third === "video")
    ) {
        id = fourth;
    }
    if (!DIGITS.test(id)) return null;
    const keyed = VIMEO_HASH.test(hash) ? `&h=${hash}` : "";
    return {
        provider: "Vimeo",
        url: `https://player.vimeo.com/video/${id}?dnt=1${keyed}`,
        shape: "video",
        start: "autoplay=1",
        needsParent: false
    };
}

/** A Spotify track, album, playlist, episode, show or artist. An address may be
 *  localised (`/intl-es/track/<id>`) or already the embed. Spotify's player does
 *  not take a parameter to start on its own. */
function spotify(parts: string[]): Embed | null {
    const at = parts.findIndex((part) => SPOTIFY_KINDS.has(part));
    const kind = at === -1 ? "" : parts[at]!;
    const id = at === -1 ? "" : (parts[at + 1] ?? "");
    if (!kind || !SPOTIFY_ID.test(id)) return null;
    return {
        provider: "Spotify",
        url: `https://open.spotify.com/embed/${kind}/${id}`,
        shape: kind === "track" || kind === "episode" ? "audio" : "post",
        start: null,
        needsParent: false
    };
}

/**
 * A TikTok video, from the page link (`/@someone/video/<id>`), the mobile one
 * (`/v/<id>.html`) or one of its embed addresses. Framed with TikTok's own
 * player rather than its page embed: the player is only the video, upright.
 */
function tiktok(parts: string[]): Embed | null {
    const [first = "", second = "", third = ""] = parts;
    const id =
        first.startsWith("@") && second === "video"
            ? third
            : first === "v"
              ? second.replace(/\.html$/, "")
              : first === "embed"
                ? second === "v2"
                    ? third
                    : second
                : first === "player" && second === "v1"
                  ? third
                  : "";
    if (!TIKTOK_ID.test(id)) return null;
    return {
        provider: "TikTok",
        url: `https://www.tiktok.com/player/v1/${id}`,
        shape: "portrait",
        start: "autoplay=1",
        needsParent: false
    };
}

/**
 * An Instagram post, reel or video, with or without the account's name in front
 * (`/someone/p/<code>`). Instagram's embed is the post as Instagram draws it -
 * the name, the picture or the reel, the caption - so it takes a post's panel
 * rather than a bare player's shape.
 */
function instagram(parts: string[]): Embed | null {
    const at = parts.findIndex(
        (part) => part === "p" || part === "reel" || part === "reels" || part === "tv"
    );
    if (at === -1 || at > 1) return null;
    const code = parts[at + 1] ?? "";
    if (!INSTAGRAM_CODE.test(code)) return null;
    const kind = parts[at] === "p" || parts[at] === "tv" ? "p" : "reel";
    return {
        provider: "Instagram",
        url: `https://www.instagram.com/${kind}/${code}/embed/`,
        shape: "post",
        start: null,
        needsParent: false
    };
}

/**
 * A post on X, on either of its names, including the `/i/web/status/` form
 * links take when the account is not known. `dnt=true` asks X not to use the
 * view for personalisation, which is the nearest thing it offers to a
 * no-cookie player.
 */
function post(parts: string[]): Embed | null {
    const at = parts.findIndex((part) => part === "status" || part === "statuses");
    if (at === -1) return null;
    const id = parts[at + 1] ?? "";
    if (!DIGITS.test(id)) return null;
    return {
        provider: "X",
        url: `https://platform.twitter.com/embed/Tweet.html?id=${id}&dnt=true`,
        shape: "post",
        start: null,
        needsParent: false
    };
}

/** A Twitch channel, a past broadcast or a clip on twitch.tv itself. */
function twitch(parts: string[]): Embed | null {
    const [first = "", second = "", third = ""] = parts;
    if (first === "videos") return twitchVideo(second);
    if (second === "clip") return twitchClip(third);
    if (second === "video" || second === "v") return twitchVideo(third);
    if (parts.length !== 1 || TWITCH_PAGES.has(first.toLowerCase()) || !TWITCH_LOGIN.test(first)) {
        return null;
    }
    return twitchPlayer(`channel=${first.toLowerCase()}`);
}

function twitchVideo(id: string): Embed | null {
    return DIGITS.test(id) ? twitchPlayer(`video=v${id}`) : null;
}

function twitchPlayer(query: string): Embed {
    return {
        provider: "Twitch",
        url: `https://player.twitch.tv/?${query}`,
        shape: "video",
        start: "autoplay=true",
        needsParent: true
    };
}

function twitchClip(slug: string): Embed | null {
    if (!TWITCH_CLIP.test(slug)) return null;
    return {
        provider: "Twitch",
        url: `https://clips.twitch.tv/embed?clip=${slug}`,
        shape: "video",
        start: "autoplay=true",
        needsParent: true
    };
}

/**
 * A SoundCloud track or playlist, public or private (a private link carries an
 * `s-` key as its last part). SoundCloud's player is told which track by a
 * SoundCloud address - rebuilt here from the checked parts, never the one that
 * was posted.
 */
function soundcloud(parts: string[]): Embed | null {
    const [user = "", second = "", third = "", fourth = ""] = parts;
    if (!SOUNDCLOUD_SLUG.test(user) || SOUNDCLOUD_PAGES.has(user.toLowerCase())) return null;

    const set = second === "sets";
    const name = set ? third : second;
    const secret = set ? fourth : third;
    const length = (set ? 3 : 2) + (secret ? 1 : 0);
    if (parts.length !== length || !SOUNDCLOUD_SLUG.test(name)) return null;
    if (!set && SOUNDCLOUD_TABS.has(name.toLowerCase())) return null;
    if (secret && !SOUNDCLOUD_SECRET.test(secret)) return null;

    const path = [user, ...(set ? ["sets"] : []), name, ...(secret ? [secret] : [])].join("/");
    const track = encodeURIComponent(`https://soundcloud.com/${path}`);
    return {
        provider: "SoundCloud",
        url: `https://w.soundcloud.com/player/?url=${track}&visual=false&show_teaser=false`,
        shape: set ? "post" : "audio",
        start: "auto_play=true",
        needsParent: false
    };
}

/**
 * A Reddit post, on any of Reddit's front doors (old., new., the mobile one). A
 * link to one comment plays the post it is under. Reddit's embed needs the
 * subreddit as well as the post, so the bare `/comments/<id>` form, which has
 * none, gets the card.
 */
function reddit(parts: string[]): Embed | null {
    const [first = "", sub = "", third = "", id = ""] = parts;
    if (first !== "r" || third !== "comments") return null;
    if (!SUBREDDIT.test(sub) || !REDDIT_POST.test(id)) return null;
    return {
        provider: "Reddit",
        url: `https://embed.reddit.com/r/${sub}/comments/${id}/?embed=true`,
        shape: "post",
        start: null,
        needsParent: false
    };
}

/** A Streamable video, from its page (`/<code>`) or its player (`/e/<code>`). */
function streamable(parts: string[]): Embed | null {
    const code =
        parts[0] === "e" || parts[0] === "o"
            ? (parts[1] ?? "")
            : parts.length === 1
              ? parts[0]!
              : "";
    if (!STREAMABLE_CODE.test(code) || STREAMABLE_PAGES.has(code.toLowerCase())) return null;
    return {
        provider: "Streamable",
        url: `https://streamable.com/e/${code}`,
        shape: "video",
        start: "autoplay=1",
        needsParent: false
    };
}

/** A Dailymotion video from its page (`/video/<id>`, sometimes with `_title`
 *  after the id), the embed, or the newer player page. */
function dailymotion(parts: string[], url: URL): Embed | null {
    const [first = "", second = "", third = ""] = parts;
    if (first === "video") return dailymotionVideo(second.split("_")[0] ?? "");
    if (first === "embed" && second === "video") return dailymotionVideo(third);
    if (first === "player.html" || /^player\/[\w-]+\.html$/.test(parts.join("/"))) {
        return dailymotionVideo(url.searchParams.get("video") ?? "");
    }
    return null;
}

function dailymotionVideo(id: string): Embed | null {
    if (!DAILYMOTION_ID.test(id)) return null;
    return {
        provider: "Dailymotion",
        url: `https://www.dailymotion.com/embed/video/${id}`,
        shape: "video",
        start: "autoplay=1",
        needsParent: false
    };
}
