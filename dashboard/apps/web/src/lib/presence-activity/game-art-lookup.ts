/**
 * Which store game a game is, found by its name, for a game reported with no
 * store id this server can ask (Epic, Riot, Battle.net, Xbox, a program somebody
 * added themselves). Pure but for the one `getJson` it is handed, so the whole
 * chain is tested against recorded answers without a network.
 *
 * The chain, every step keyless (research and sources: docs/game-art-sources.md):
 *
 * 1. **Steam store search** (`store.steampowered.com/api/storesearch`).
 * 2. **Microsoft Store suggestions** (`displaycatalog.mp.microsoft.com` autosuggest,
 *    the catalog Windows' Store reads), which sells Fortnite, Valorant, League of
 *    Legends, Genshin Impact and most of what Xbox PC carries.
 * 3. **Wikidata** (`query.wikidata.org`, CC0), whose game items carry their Steam
 *    (P1733), GOG (P2725) and Microsoft Store (P5885) ids - Minecraft and Roblox
 *    are found here.
 *
 * Only an exact match counts: the store's title and the reported name must be
 * the same once both are normalized (`normalizeGameName`). Two different games
 * with that title at one step is ambiguous, and ends the chain with no picture:
 * a wrong logo beside somebody's name is worse than the game glyph.
 */

/** The longest normalized name looked up; a longer one is not a game's title. */
export const MAX_NAME_LENGTH = 100;

/** A lookup by name as a picture reference: `name:fall guys`. */
export const NAME_REF = /^name:[a-z0-9]+(?: [a-z0-9]+)*$/;

/**
 * A game's title reduced to what two spellings of it share: accents, case,
 * trademark signs and punctuation dropped, `&` read as "and", apostrophes
 * removed without a gap ("Tom Clancy's" -> "tom clancys"). Null when nothing
 * is left (a title with no Latin letters or digits) or it is too long.
 */
export function normalizeGameName(raw: string): string | null {
    // The signs go first: NFKD would spell a trademark sign out as "TM".
    const name = raw
        .replace(/[™®©]/g, "")
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/['’`]/g, "")
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    return name && name.length <= MAX_NAME_LENGTH ? name : null;
}

/** The picture reference a game with no store id is drawn by, or null for a name that cannot be looked up. */
export function nameRefOf(name: string): string | null {
    const normalized = normalizeGameName(name);
    return normalized ? `name:${normalized}` : null;
}

/** The name a `name:` reference looks up, or null when it is not one. */
export function nameOfRef(ref: string): string | null {
    if (ref.length > MAX_NAME_LENGTH + 5 || !NAME_REF.test(ref)) return null;
    return ref.slice(5);
}

export function steamSearchUrl(name: string): string {
    return `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&cc=US&l=english`;
}

export function msStoreSearchUrl(name: string): string {
    return `https://displaycatalog.mp.microsoft.com/v7.0/productFamilies/autosuggest?market=US&languages=en-US&productFamilyNames=games&query=${encodeURIComponent(name)}`;
}

/** Wikidata's video game class; an item that is not one (a soundtrack, a list, a franchise) is never taken. */
const VIDEO_GAME = "Q7889";

export function wikidataUrl(name: string): string {
    // The name only ever holds [a-z0-9 ] (`normalizeGameName`), so it cannot
    // break out of the string it is placed in.
    const query = `SELECT ?item ?label ?steam ?gog ?ms WHERE {
SERVICE wikibase:mwapi { bd:serviceParam wikibase:endpoint "www.wikidata.org"; wikibase:api "EntitySearch"; mwapi:search "${name}"; mwapi:language "en"; mwapi:limit "10". ?item wikibase:apiOutputItem mwapi:item. }
?item wdt:P31 wd:${VIDEO_GAME} .
?item rdfs:label|skos:altLabel ?label . FILTER(LANG(?label) = "en")
OPTIONAL { ?item wdt:P1733 ?steam } OPTIONAL { ?item wdt:P2725 ?gog } OPTIONAL { ?item wdt:P5885 ?ms }
}`;
    return `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`;
}

/** What one step found: a store id, nothing, or more than one game by that title. */
export type StepResult = { kind: "match"; ref: string } | { kind: "none" } | { kind: "ambiguous" };

function decide(refs: Iterable<string>): StepResult {
    const distinct = [...new Set(refs)];
    if (distinct.length === 0) return { kind: "none" };
    return distinct.length === 1 ? { kind: "match", ref: distinct[0]! } : { kind: "ambiguous" };
}

const STEAM_ID = /^\d{1,10}$/;
const GOG_ID = /^\d{1,12}$/;
const MS_ID = /^[0-9A-Za-z]{12}$/;

function text(value: unknown): string {
    return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

/** The Steam apps in a store search answer whose title is exactly this name. */
export function steamStep(body: unknown, name: string): StepResult {
    const items = (body as { items?: unknown[] } | null)?.items;
    if (!Array.isArray(items)) return { kind: "none" };
    const refs: string[] = [];
    for (const item of items) {
        const entry = item as { id?: unknown; name?: unknown; type?: unknown };
        const id = text(entry?.id);
        if (entry?.type !== "app" || !STEAM_ID.test(id)) continue;
        if (normalizeGameName(text(entry.name)) === name) refs.push(`steam:${id}`);
    }
    return decide(refs);
}

/** The Microsoft Store games in a suggestion answer whose title is exactly this name. */
export function msStoreStep(body: unknown, name: string): StepResult {
    const results = (body as { Results?: unknown[] } | null)?.Results;
    if (!Array.isArray(results)) return { kind: "none" };
    const refs: string[] = [];
    for (const family of results) {
        const products = (family as { Products?: unknown[] } | null)?.Products;
        if (!Array.isArray(products)) continue;
        for (const product of products) {
            const entry = product as { ProductId?: unknown; Title?: unknown; Type?: unknown };
            const id = text(entry?.ProductId);
            if (entry?.Type !== "Game" || !MS_ID.test(id)) continue;
            if (normalizeGameName(text(entry.Title)) === name) refs.push(`msstore:${id.toUpperCase()}`);
        }
    }
    return decide(refs);
}

/**
 * The store id of the one Wikidata game whose English label or alias is exactly
 * this name. Its Steam id is taken first, then GOG, then the Microsoft Store;
 * several ids of one store on one item (editions) are the same game, so the
 * lowest is taken. Two items both titled so are two games: ambiguous.
 */
export function wikidataStep(body: unknown, name: string): StepResult {
    const rows = (body as { results?: { bindings?: unknown[] } } | null)?.results?.bindings;
    if (!Array.isArray(rows)) return { kind: "none" };
    const items = new Map<string, { exact: boolean; steam: Set<string>; gog: Set<string>; ms: Set<string> }>();
    for (const row of rows) {
        const value = (key: string): string => text((row as Record<string, { value?: unknown } | undefined>)?.[key]?.value);
        const item = value("item");
        if (!/^http:\/\/www\.wikidata\.org\/entity\/Q\d+$/.test(item)) continue;
        const entry = items.get(item) ?? { exact: false, steam: new Set<string>(), gog: new Set<string>(), ms: new Set<string>() };
        items.set(item, entry);
        if (normalizeGameName(value("label")) === name) entry.exact = true;
        if (STEAM_ID.test(value("steam"))) entry.steam.add(value("steam"));
        if (GOG_ID.test(value("gog"))) entry.gog.add(value("gog"));
        if (MS_ID.test(value("ms"))) entry.ms.add(value("ms").toUpperCase());
    }
    const exact = [...items.values()].filter((entry) => entry.exact);
    if (exact.length > 1) return { kind: "ambiguous" };
    const entry = exact[0];
    if (!entry) return { kind: "none" };
    const lowest = (ids: Set<string>, numeric: boolean): string | undefined =>
        [...ids].sort((a, b) => (numeric ? Number(a) - Number(b) : a.localeCompare(b)))[0];
    const steam = lowest(entry.steam, true);
    if (steam) return { kind: "match", ref: `steam:${steam}` };
    const gog = lowest(entry.gog, true);
    if (gog) return { kind: "match", ref: `gog:${gog}` };
    const ms = lowest(entry.ms, false);
    return ms ? { kind: "match", ref: `msstore:${ms}` } : { kind: "none" };
}

/** The steps, in the order they are asked. */
export const STEPS = [
    { source: "steam", url: steamSearchUrl, read: steamStep },
    { source: "msstore", url: msStoreSearchUrl, read: msStoreStep },
    { source: "wikidata", url: wikidataUrl, read: wikidataStep }
] as const;

export type LookupSource = (typeof STEPS)[number]["source"];

/** What a lookup settled: the store id and where it was found, or why there is none. */
export type Lookup =
    | { ref: string; source: LookupSource; reason: "match" }
    | { ref: null; source: LookupSource | null; reason: "none" | "ambiguous" };

/**
 * Find the store id for a normalized name. `getJson` answers a source's parsed
 * body, or `undefined` when the source could not be asked (down, refused, rate
 * limited) - then the whole lookup is `undefined` too, so a source that did not
 * answer is never remembered as one that had nothing.
 */
export async function lookupByName(
    name: string,
    getJson: (url: string, source: LookupSource) => Promise<unknown | undefined>
): Promise<Lookup | undefined> {
    for (const step of STEPS) {
        const body = await getJson(step.url(name), step.source);
        if (body === undefined) return undefined;
        const found = step.read(body, name);
        if (found.kind === "match") return { ref: found.ref, source: step.source, reason: "match" };
        if (found.kind === "ambiguous") return { ref: null, source: step.source, reason: "ambiguous" };
    }
    return { ref: null, source: null, reason: "none" };
}
