/**
 * Where a game's picture comes from: the store that sells it, asked by this
 * server by the store's own id. Pure, so the addresses and the reading of each
 * store's answer are tested without a network.
 *
 * The rule, the one Discord keeps with its own registry: a picture beside
 * somebody's name is one a store published for that game, never one a computer
 * sent. A computer says only which game it is (`gameStoreRefSchema`).
 *
 * The stores asked, and the ones that are not:
 *
 * - **Steam** - `IStoreBrowseService/GetItems`, answered without a key, gives
 *   the app's published assets; the library capsule (600x900 box art) is the
 *   picture, its header the fallback. The community icon is only 32px. One call
 *   per game per server keeps far inside the Steam Web API terms' 100,000 calls a
 *   day, and the pictures are shown only to identify the game being played.
 * - **GOG** - `api.gog.com/products/<id>`, public and unauthenticated, whose
 *   `images.icon` is the 128px square GOG Galaxy draws.
 * - **Epic, Ubisoft, packaged apps** - not asked. Epic's catalog has no public,
 *   documented endpoint (its store's GraphQL is undocumented and needs a session),
 *   Ubisoft publishes none, and a packaged app's AUMID is not a Microsoft Store
 *   product id. Their games draw the neutral game glyph unless the program is one
 *   `CURATED_ART` knows by its Steam id.
 */

import * as core from "@polaris/core";

/** A store's answer is a few KB; anything past this is not one. */
export const MAX_METADATA_BYTES = 512 * 1024;

/** The longest a picture from a store may be before it is refused. */
export const MAX_ART_BYTES = 4 * 1024 * 1024;

/**
 * Programs whose Steam id is known here, so a game is drawn even when the
 * computer reporting it says no store id - an older desktop app, or the game
 * installed from a store that has no public catalog (Rocket League from Epic).
 * Every id was read from Steam's own `appdetails`/`storesearch` answer for that
 * title; a program missing here is one that Steam does not sell.
 */
export const CURATED_ART: Readonly<Record<string, string>> = {
    "among us.exe": "steam:945360",
    "r5apex.exe": "steam:1172470",
    "shootergame.exe": "steam:346110",
    "bg3.exe": "steam:1086940",
    "bg3_dx11.exe": "steam:1086940",
    "celeste.exe": "steam:504230",
    "cs2.exe": "steam:730",
    cs2: "steam:730",
    "cyberpunk2077.exe": "steam:1091500",
    "deadbydaylight-win64-shipping.exe": "steam:381210",
    "dota2.exe": "steam:570",
    dota2: "steam:570",
    "eldenring.exe": "steam:1245620",
    "factorio.exe": "steam:427520",
    factorio: "steam:427520",
    "gta5.exe": "steam:271590",
    "helldivers2.exe": "steam:553850",
    "hollow_knight.exe": "steam:367520",
    "lethal company.exe": "steam:1966720",
    "overwatch.exe": "steam:2357570",
    "palworld-win64-shipping.exe": "steam:1623730",
    "tslgame.exe": "steam:578080",
    "rainbowsix.exe": "steam:359550",
    "rocketleague.exe": "steam:252950",
    "rustclient.exe": "steam:252490",
    "sotgame.exe": "steam:1172620",
    "terraria.exe": "steam:105600",
    "ts4_x64.exe": "steam:1222670",
    "valheim.exe": "steam:892970"
};

/** The store id a game's picture is looked up by: the curated one first, then
 *  what the reporting computer said, then what an earlier report taught. */
export function artRefFor(
    key: string,
    reported: string | null | undefined,
    learned: string | null | undefined
): string | null {
    for (const ref of [CURATED_ART[key], reported, learned]) {
        if (ref && core.GAME_STORE_REF.test(ref) && resolvable(ref)) return ref;
    }
    return null;
}

/** Whether a store is one this server asks for pictures. */
export function resolvable(ref: string): boolean {
    const store = core.gameStoreOf(ref);
    return store === "steam" || store === "gog";
}

/** The address of the store's metadata for this game, or null for a store not asked. */
export function metadataUrl(ref: string): string | null {
    if (!core.GAME_STORE_REF.test(ref)) return null;
    const id = ref.slice(ref.indexOf(":") + 1);
    if (core.gameStoreOf(ref) === "steam") {
        const input = {
            ids: [{ appid: Number(id) }],
            context: { language: "english", country_code: "US" },
            data_request: { include_assets: true }
        };
        return `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`;
    }
    if (core.gameStoreOf(ref) === "gog") return `https://api.gog.com/products/${id}`;
    return null;
}

/** Only these hosts are fetched a picture from, whatever a store's answer names. */
const ART_HOSTS = [/^shared\.(?:akamai|cloudflare)\.steamstatic\.com$/, /^cdn\.(?:akamai|cloudflare)\.steamstatic\.com$/, /^images-\d\.gog-statics\.com$/];

function artAddress(raw: string): string | null {
    let url: URL;
    try {
        url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return ART_HOSTS.some((host) => host.test(url.hostname)) ? url.href : null;
}

const FILE = /^[A-Za-z0-9_./-]{1,200}\.(?:jpg|png)$/;

/** The picture's address in a store's metadata answer, or null when it has none. */
export function artUrlFrom(ref: string, body: unknown): string | null {
    if (!body || typeof body !== "object") return null;
    if (core.gameStoreOf(ref) === "steam") {
        const item = (body as { response?: { store_items?: unknown[] } }).response?.store_items?.[0];
        const assets = (item as { assets?: Record<string, unknown> } | undefined)?.assets;
        const format = assets?.asset_url_format;
        if (typeof format !== "string" || !format.includes("${FILENAME}")) return null;
        for (const name of ["library_capsule", "library_capsule_2x", "header"]) {
            const file = assets?.[name];
            if (typeof file !== "string" || !FILE.test(file) || file.includes("..")) continue;
            const path = format.replace("${FILENAME}", file);
            if (!/^steam\/apps\/\d{1,10}\//.test(path)) return null;
            return artAddress(`https://shared.akamai.steamstatic.com/store_item_assets/${path}`);
        }
        return null;
    }
    if (core.gameStoreOf(ref) === "gog") {
        const icon = (body as { images?: { icon?: unknown } }).images?.icon;
        return typeof icon === "string" ? artAddress(icon) : null;
    }
    return null;
}

/** Where a reader's browser asks this server for a game's picture. */
export function artRoute(ref: string): string {
    return `/api/activity/game-art/${encodeURIComponent(ref)}`;
}
