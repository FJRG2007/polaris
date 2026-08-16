/**
 * What a Steam Workshop mod is, and how to recognise one.
 *
 * The pure half: the shape a mod is described in, the two addresses that belong to
 * Steam, and the id inside whatever somebody pasted. Kept apart from the calls that
 * fetch any of it because the Mods screen is a browser component - it renders a
 * link and an image address, and pulling the server's Steam key into that bundle
 * to do it would be absurd.
 */

/** ARK: Survival Evolved, which is the only game whose mods belong on this
 *  server - a Workshop id from another game installs and does nothing. */
export const ARK_APP_ID = 346110;

/** One mod, as much as Steam will say about it. */
export interface WorkshopItem {
    readonly id: string;
    readonly title: string;
    /** The first lines of its description, with the Workshop's own markup left in
     *  place - it is quoted, never rendered. */
    readonly summary: string;
    /** Steam's own preview image, or null. Never handed to a browser directly; the
     *  screen loads it through Polaris. */
    readonly previewUrl: string | null;
    readonly sizeBytes: number | null;
    /** How many people subscribe to it, which is the only popularity signal Steam
     *  gives away without a key. */
    readonly subscriptions: number | null;
    /** When it was last changed, as an ISO timestamp. A mod nobody has touched in
     *  three years is worth seeing before it is installed on a server. */
    readonly updatedAt: string | null;
    /** Whether it is an ARK mod at all. False for an id from another game, which
     *  is the commonest way a mod list silently does nothing. */
    readonly forArk: boolean;
    /** Whether Steam has taken it down. An id that is banned or deleted is one the
     *  server will keep failing to install. */
    readonly gone: boolean;
}

/**
 * The Workshop id in whatever somebody pasted.
 *
 * A bare id, a `?id=` link, or the whole address bar including the collection
 * they were browsing - all of them are what a person has in their clipboard, and
 * refusing the ones with a URL around them would be refusing the commonest case.
 */
export function parseWorkshopId(input: string): string | null {
    const text = input.trim();
    if (/^\d{6,12}$/.test(text)) return text;
    const fromQuery = /[?&]id=(\d{6,12})\b/.exec(text);
    if (fromQuery?.[1]) return fromQuery[1];
    return null;
}

/** Whether an address is one of Steam's own image hosts, which is what the icon
 *  route checks before fetching anything. */
export function isWorkshopImage(url: string | null | undefined): boolean {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") return false;
        return (
            parsed.hostname === "images.steamusercontent.com" ||
            parsed.hostname === "steamuserimages-a.akamaihd.net" ||
            parsed.hostname.endsWith(".steamstatic.com") ||
            parsed.hostname.endsWith(".akamaihd.net")
        );
    } catch {
        return false;
    }
}

/** Where a mod's own page is, for the link every row carries. */
export function workshopUrl(id: string): string {
    return `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;
}

