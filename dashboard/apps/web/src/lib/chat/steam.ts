/**
 * A Steam store link, described the way Discord's card does it: the game's
 * name, its short description, what it costs (and what it cost before a sale)
 * or that it is free, how many people recommend it, and its header picture.
 * When it came out and which systems it runs on are kept too.
 *
 * The store page itself is no use for this. It sends anybody without a cookie
 * to an age gate for half the catalogue, and its `og:` tags carry a title and a
 * picture but no price. Steam's own storefront answers the same question as one
 * JSON document, keyless:
 *
 *     https://store.steampowered.com/api/appdetails?appids=<id>&cc=<country>&l=<language>
 *
 * The shape below was read off real answers (Cyberpunk 2077 on sale, Dota 2 free
 * to play, Black Myth: Wukong at full price, an unknown id), not guessed. The
 * answer is checked with a schema before anything is kept, because it is a third
 * party's document and every field of it is optional in practice.
 *
 * The price depends on the country asked for, so this asks for the one that
 * matches the currency the operator chose for the whole instance, in the
 * instance's language. One stored card per link is shared by everybody, which
 * is why it is the instance's choice and not the reader's.
 */

import { z } from "zod";

/** What a store link carries for the card, kept on the preview row. */
export interface SteamDetails {
    readonly kind: "steam";
    readonly appId: string;
    /** Free to play: no price at all, and the card says so instead. */
    readonly free: boolean;
    /** Null when the game has no price to show - free, or not on sale yet. */
    readonly price: {
        /** What it costs now, as Steam writes it for that country (`17,99€`). */
        readonly final: string;
        /** What it cost before the sale, or empty when there is no sale. */
        readonly initial: string;
        /** The sale, as a whole percentage. Zero when there is none. */
        readonly discount: number;
    } | null;
    /** Not out yet. The date is then whatever Steam says instead of one - "Q1
     *  2027", "To be announced" - and may be empty. */
    readonly comingSoon: boolean;
    /** As Steam writes it in the language asked for. */
    readonly releaseDate: string;
    readonly platforms: {
        readonly windows: boolean;
        readonly mac: boolean;
        readonly linux: boolean;
    };
    /** How many people recommend it on Steam - the count Discord's card shows
     *  as "Recommendations". Absent on a card stored before it was read, and
     *  null for a game nobody has reviewed yet. */
    readonly recommendations?: number | null;
}

/** How long a Steam card is trusted. Prices move with sales, which start and
 *  end on the hour, so a week-old card would show a sale that is over. */
export const STEAM_FRESH_MS = 6 * 60 * 60 * 1000;

const APP_ID = /^\d{1,10}$/;

/**
 * The app a store link is about, or null for anything else.
 *
 * `store.steampowered.com/app/<id>/<slug>/` is what the store's share button
 * and the address bar both give; the age gate's `/agecheck/app/<id>` is the
 * same game. Bundles, packages and the community site are not games and keep
 * the ordinary card.
 */
export function steamAppOf(address: string): string | null {
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.hostname.toLowerCase() !== "store.steampowered.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const at = parts[0] === "agecheck" ? 1 : 0;
    if (parts[at] !== "app") return null;
    const id = parts[at + 1] ?? "";
    return APP_ID.test(id) ? id : null;
}

/** The country Steam prices in for each currency Polaris can be set to. A
 *  currency Steam does not sell in (the krone) falls back to the region Steam
 *  puts that country in, and the card shows whatever currency Steam answers
 *  with - its own formatted price says which. */
const COUNTRY_FOR: Readonly<Record<string, string>> = {
    EUR: "de",
    USD: "us",
    GBP: "gb",
    CHF: "ch",
    SEK: "se",
    NOK: "no",
    DKK: "dk",
    PLN: "pl",
    CAD: "ca",
    AUD: "au",
    MXN: "mx",
    BRL: "br",
    ARS: "ar",
    COP: "co",
    CLP: "cl",
    JPY: "jp",
    CNY: "cn",
    INR: "in"
};

/** Steam's own names for the languages Polaris speaks. */
const LANGUAGE_FOR: Readonly<Record<string, string>> = {
    "en-US": "english",
    "es-ES": "spanish"
};

/** The storefront address for one app, priced and written for the instance. */
export function steamDetailsUrl(appId: string, currency: string, language: string): string {
    const query = new URLSearchParams({
        appids: appId,
        cc: COUNTRY_FOR[currency] ?? "us",
        l: LANGUAGE_FOR[language] ?? "english"
    });
    return `https://store.steampowered.com/api/appdetails?${query.toString()}`;
}

/** The part of Steam's answer the card uses. Everything else in it - the long
 *  description, screenshots, requirements - is ignored, not refused. */
const appSchema = z.object({
    type: z.string().optional(),
    name: z.string().min(1).max(300),
    is_free: z.boolean().optional(),
    short_description: z.string().max(5000).optional(),
    header_image: z.string().url().max(2000).optional(),
    developers: z.array(z.string().max(200)).max(20).optional(),
    price_overview: z
        .object({
            final: z.number().int().nonnegative().optional(),
            initial: z.number().int().nonnegative().optional(),
            discount_percent: z.number().int().min(0).max(100).optional(),
            final_formatted: z.string().max(40).optional(),
            initial_formatted: z.string().max(40).optional()
        })
        .optional(),
    release_date: z
        .object({ coming_soon: z.boolean().optional(), date: z.string().max(80).optional() })
        .optional(),
    platforms: z
        .object({
            windows: z.boolean().optional(),
            mac: z.boolean().optional(),
            linux: z.boolean().optional()
        })
        .optional(),
    recommendations: z.object({ total: z.number().int().nonnegative() }).optional()
});

const answerSchema = z.record(
    z.string(),
    z.object({ success: z.boolean(), data: z.unknown().optional() })
);

/** What the card says about one app, read out of Steam's answer. */
export interface SteamDescribed {
    readonly title: string;
    readonly author: string;
    readonly description: string;
    readonly imageUrl: string | null;
    readonly details: SteamDetails;
}

/**
 * Steam's answer for one app, checked and narrowed to what the card draws, or
 * null when Steam does not know the app (`success: false`) or answered with
 * something this does not recognise.
 */
export function readSteamAnswer(appId: string, payload: unknown): SteamDescribed | null {
    const answer = answerSchema.safeParse(payload);
    if (!answer.success) return null;
    const entry = answer.data[appId];
    if (!entry?.success) return null;
    const app = appSchema.safeParse(entry.data);
    if (!app.success) return null;
    const data = app.data;

    const overview = data.price_overview;
    const discount = overview?.discount_percent ?? 0;
    const final = overview?.final_formatted?.trim() ?? "";
    const free = data.is_free === true;
    const price =
        !free && final
            ? {
                  final,
                  initial: discount > 0 ? (overview?.initial_formatted?.trim() ?? "") : "",
                  discount
              }
            : null;
    const image =
        data.header_image && /^https:\/\//i.test(data.header_image) ? data.header_image : null;

    return {
        title: data.name.slice(0, 200),
        author: (data.developers ?? []).slice(0, 2).join(", ").slice(0, 100),
        description: decodeEntities(data.short_description ?? "").slice(0, 400),
        imageUrl: image,
        details: {
            kind: "steam",
            appId,
            free,
            price,
            comingSoon: data.release_date?.coming_soon === true,
            releaseDate: (data.release_date?.date ?? "").trim(),
            platforms: {
                windows: data.platforms?.windows === true,
                mac: data.platforms?.mac === true,
                linux: data.platforms?.linux === true
            },
            recommendations: data.recommendations?.total ?? null
        }
    };
}

/** The stored details, read back. A row written before a field existed, or by
 *  an older shape, reads as no details rather than as a broken card. */
const storedSchema = z.object({
    kind: z.literal("steam"),
    appId: z.string().regex(APP_ID),
    free: z.boolean(),
    price: z
        .object({
            final: z.string().max(40),
            initial: z.string().max(40),
            discount: z.number().int().min(0).max(100)
        })
        .nullable(),
    comingSoon: z.boolean(),
    releaseDate: z.string().max(80),
    platforms: z.object({ windows: z.boolean(), mac: z.boolean(), linux: z.boolean() }),
    recommendations: z.number().int().nonnegative().nullable().optional()
});

export function storedSteamDetails(value: string | null | undefined): SteamDetails | null {
    if (!value) return null;
    try {
        const parsed = storedSchema.safeParse(JSON.parse(value));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** Steam's short descriptions are HTML-escaped text (`&quot;`, `&amp;`). They
 *  are drawn as text, so the escapes are undone here rather than shown. */
function decodeEntities(value: string): string {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .trim();
}
