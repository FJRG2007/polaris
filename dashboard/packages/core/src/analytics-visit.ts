/**
 * Turning what a request carries into what a person reading analytics wants to know:
 * which browser, which system, which kind of device, where the visit came from.
 *
 * Deliberately small and dependency-free. A user-agent library is a monthly update
 * treadmill for a result nobody checks, and the long tail it buys is a rounding error
 * next to Chrome, Safari, Firefox and Edge. What matters far more is that the common
 * cases are right and that bots are recognised, because a bot counted as a visitor is
 * the thing that makes a whole dashboard untrustworthy.
 *
 * Pure: given the strings, produce the facts.
 */

export const DEVICE_KINDS = ["desktop", "mobile", "tablet", "bot", "unknown"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const REFERRER_KINDS = ["direct", "search", "social", "referral", "campaign"] as const;
export type ReferrerKind = (typeof REFERRER_KINDS)[number];

export interface VisitAgent {
    readonly browser: string;
    readonly os: string;
    readonly device: DeviceKind;
}

export interface VisitSource {
    readonly kind: ReferrerKind;
    /** Where it came from, as a person would name it: "Google", "example.com", or
     *  the campaign source. Null for a direct visit. */
    readonly source: string | null;
    readonly medium: string | null;
    readonly campaign: string | null;
}

/**
 * Anything that says it is a bot, plus the ones that do not.
 *
 * Two lists on purpose: the honest half matches a word any crawler puts in its agent
 * string, and the second names the tools that do not announce themselves that way.
 * Order matters - this runs before browser detection, because half of these also
 * claim to be Mozilla.
 */
const BOT_MARKERS = [
    "bot",
    "crawler",
    "spider",
    "slurp",
    "facebookexternalhit",
    "preview",
    "monitor",
    "uptime",
    "pingdom",
    "headlesschrome",
    "phantomjs",
    "puppeteer",
    "playwright",
    "curl/",
    "wget/",
    "python-requests",
    "python-urllib",
    "go-http-client",
    "java/",
    "okhttp",
    "axios/",
    "node-fetch",
    "postman"
];

/** Browsers, most specific first: Edge claims Chrome, Chrome claims Safari, and
 *  every one of them claims Mozilla. */
const BROWSERS: readonly (readonly [string, string])[] = [
    ["edg/", "Edge"],
    ["edga/", "Edge"],
    ["edgios/", "Edge"],
    ["opr/", "Opera"],
    ["opera", "Opera"],
    ["vivaldi", "Vivaldi"],
    ["brave", "Brave"],
    ["samsungbrowser", "Samsung Internet"],
    ["yabrowser", "Yandex"],
    ["duckduckgo", "DuckDuckGo"],
    ["firefox/", "Firefox"],
    ["fxios/", "Firefox"],
    ["chrome/", "Chrome"],
    ["crios/", "Chrome"],
    ["chromium", "Chromium"],
    ["safari/", "Safari"]
];

/** Systems, most specific first: Android says Linux, iPadOS says Mac. */
const SYSTEMS: readonly (readonly [string, string])[] = [
    ["windows nt 10", "Windows"],
    ["windows nt 11", "Windows"],
    ["windows", "Windows"],
    ["android", "Android"],
    ["cros", "ChromeOS"],
    ["iphone", "iOS"],
    ["ipad", "iPadOS"],
    ["ipod", "iOS"],
    ["mac os x", "macOS"],
    ["macintosh", "macOS"],
    ["ubuntu", "Ubuntu"],
    ["fedora", "Fedora"],
    ["freebsd", "FreeBSD"],
    ["openbsd", "OpenBSD"],
    ["linux", "Linux"]
];

const UNKNOWN_AGENT: VisitAgent = { browser: "Unknown", os: "Unknown", device: "unknown" };

/** What a user agent says about the client. */
export function parseVisitAgent(userAgent: string | null | undefined): VisitAgent {
    if (!userAgent || userAgent.trim() === "" || userAgent === "-") return UNKNOWN_AGENT;
    const lower = userAgent.toLowerCase();

    if (BOT_MARKERS.some((marker) => lower.includes(marker))) {
        return { browser: botName(userAgent), os: "Unknown", device: "bot" };
    }

    const browser = BROWSERS.find(([token]) => lower.includes(token))?.[1] ?? "Unknown";
    const os = SYSTEMS.find(([token]) => lower.includes(token))?.[1] ?? "Unknown";

    // A tablet says so, or is an iPad. Everything else with "mobile" in it is a phone.
    let device: DeviceKind = "desktop";
    if (lower.includes("ipad") || lower.includes("tablet") || (lower.includes("android") && !lower.includes("mobile"))) {
        device = "tablet";
    } else if (lower.includes("mobile") || lower.includes("iphone") || lower.includes("ipod")) {
        device = "mobile";
    } else if (os === "Unknown" && browser === "Unknown") {
        device = "unknown";
    }
    return { browser, os, device };
}

/** The bot's own name where it gives one, so the breakdown says "Googlebot" rather
 *  than lumping every crawler under one row. */
function botName(userAgent: string): string {
    const named = /([A-Za-z][A-Za-z0-9._-]*(?:bot|crawler|spider))/i.exec(userAgent);
    if (named?.[1]) return named[1];
    const tool = /^([A-Za-z][A-Za-z0-9._-]*)\//.exec(userAgent.trim());
    return tool?.[1] ?? "Bot";
}

/** Hosts that are a search engine rather than a site that linked to you. */
const SEARCH_HOSTS: readonly (readonly [string, string])[] = [
    ["google.", "Google"],
    ["bing.com", "Bing"],
    ["duckduckgo.com", "DuckDuckGo"],
    ["search.yahoo", "Yahoo"],
    ["yandex.", "Yandex"],
    ["baidu.com", "Baidu"],
    ["ecosia.org", "Ecosia"],
    ["brave.com", "Brave Search"],
    ["startpage.com", "Startpage"],
    ["qwant.com", "Qwant"],
    ["perplexity.ai", "Perplexity"],
    ["chatgpt.com", "ChatGPT"],
    ["chat.openai.com", "ChatGPT"],
    ["claude.ai", "Claude"]
];

const SOCIAL_HOSTS: readonly (readonly [string, string])[] = [
    ["t.co", "X"],
    ["twitter.com", "X"],
    ["x.com", "X"],
    ["facebook.com", "Facebook"],
    ["fb.me", "Facebook"],
    ["instagram.com", "Instagram"],
    ["linkedin.com", "LinkedIn"],
    ["lnkd.in", "LinkedIn"],
    ["reddit.com", "Reddit"],
    ["news.ycombinator.com", "Hacker News"],
    ["youtube.com", "YouTube"],
    ["youtu.be", "YouTube"],
    ["t.me", "Telegram"],
    ["discord.com", "Discord"],
    ["mastodon", "Mastodon"],
    ["bsky.app", "Bluesky"],
    ["tiktok.com", "TikTok"],
    ["pinterest.", "Pinterest"],
    ["whatsapp.com", "WhatsApp"]
];

const DIRECT: VisitSource = { kind: "direct", source: null, medium: null, campaign: null };

/**
 * Where a visit came from.
 *
 * A campaign wins over the referrer, because that is the point of tagging one: a
 * newsletter link opened from Gmail is the newsletter, not Gmail. `self` is the site's
 * own hostname, so its internal links are not counted as referrals from itself.
 */
export function parseVisitSource(
    referrer: string | null | undefined,
    query?: string | null,
    self?: string | null
): VisitSource {
    const utm = parseUtm(query);
    if (utm) return utm;
    if (!referrer || referrer === "-" || referrer.trim() === "") return DIRECT;

    let host: string;
    try {
        host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
        return DIRECT;
    }
    if (host === "") return DIRECT;
    if (self && host === self.toLowerCase().replace(/^www\./, "")) return DIRECT;

    const search = SEARCH_HOSTS.find(([token]) => host.includes(token));
    if (search) return { kind: "search", source: search[1], medium: "organic", campaign: null };

    const social = SOCIAL_HOSTS.find(([token]) => host === token || host.endsWith(`.${token}`) || host.includes(token));
    if (social) return { kind: "social", source: social[1], medium: "social", campaign: null };

    return { kind: "referral", source: host, medium: "referral", campaign: null };
}

function parseUtm(query: string | null | undefined): VisitSource | null {
    if (!query) return null;
    let params: URLSearchParams;
    try {
        params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
    } catch {
        return null;
    }
    const source = params.get("utm_source") ?? params.get("ref");
    const medium = params.get("utm_medium");
    const campaign = params.get("utm_campaign");
    if (!source && !medium && !campaign) return null;
    return { kind: "campaign", source: source?.slice(0, 120) ?? null, medium: medium?.slice(0, 120) ?? null, campaign: campaign?.slice(0, 120) ?? null };
}

/**
 * A path reduced to the route it belongs to, so /post/1 and /post/2 are one row.
 *
 * Only the segments that are obviously an identifier are replaced - a number, a uuid,
 * a long hex or slug-with-hash. Guessing harder than that turns /about into a
 * placeholder, and a breakdown that hides the page names is worse than one with a few
 * extra rows in it.
 */
export function groupVisitPath(path: string): string {
    const clean = (path.split("?")[0] ?? "/").replace(/\/+$/, "") || "/";
    const grouped = clean
        .split("/")
        .map((segment) => {
            if (segment === "") return segment;
            if (/^\d+$/.test(segment)) return ":id";
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ":id";
            if (/^[0-9a-f]{16,}$/i.test(segment)) return ":id";
            return segment;
        })
        .join("/");
    return grouped === "" ? "/" : grouped;
}
