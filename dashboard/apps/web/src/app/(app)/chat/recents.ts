"use client";

/**
 * What this person reached for last.
 *
 * Nine emoji out of two thousand are ninety per cent of what anybody sends, and
 * they are not the same nine for any two people. So the picker opens on the ones
 * this person actually uses rather than on smileys, which is what every
 * messenger does and the single thing that makes a picker feel like it knows
 * you.
 *
 * Kept in the browser rather than on the server, deliberately. It is a habit
 * rather than a possession: it is worth nothing to anybody else, it changes on
 * every press, and a round trip per emoji to record something nobody will ever
 * read is a request per press for no one's benefit. The cost is that it does not
 * follow somebody to another machine - which is what "recent on this device"
 * means everywhere else too.
 *
 * Under the `polaris.` prefix, so the button that empties this browser clears it
 * with everything else.
 */

/** How many are remembered. Two rows of a picker: enough that the one somebody
 *  wants is usually there, few enough that it is still a shortcut rather than a
 *  second catalogue. */
const KEEP = 24;

const EMOJI_KEY = "polaris.chat.recent.emoji";
const MEDIA_KEY = "polaris.chat.recent.media";

/** One GIF or sticker, as the grid needs to draw it again without asking
 *  anybody. */
export interface RecentMedia {
    readonly preview: string;
    readonly full: string;
    readonly description: string;
}

export function recentEmoji(): string[] {
    return read<string>(EMOJI_KEY).filter((entry) => typeof entry === "string" && entry.length > 0);
}

/** Move one to the front, or put it there. Pressing the same one twice does not
 *  make two entries: it is the same habit, recorded once. */
export function rememberEmoji(char: string): void {
    if (!char) return;
    write(
        EMOJI_KEY,
        [char, ...recentEmoji().filter((entry) => entry !== char)].slice(0, KEEP)
    );
}

export function recentMedia(): RecentMedia[] {
    return read<RecentMedia>(MEDIA_KEY).filter(
        (entry): entry is RecentMedia =>
            typeof entry?.preview === "string" && typeof entry?.full === "string"
    );
}

export function rememberMedia(media: RecentMedia): void {
    if (!media.full) return;
    write(
        MEDIA_KEY,
        [media, ...recentMedia().filter((entry) => entry.full !== media.full)].slice(0, KEEP)
    );
}

/** Where each space's last-opened channel is kept, one entry per space. */
const LAST_CHANNEL_KEY = "polaris.chat.lastChannel";

/**
 * The channel this browser last had open in a space, and the note that records
 * it.
 *
 * Picking a space used to change the list on the left and nothing else, so
 * somebody who chose a server went on looking at the direct message they had
 * been reading - which reads as a click that did nothing. A space opens on a
 * channel now, and the one it opens on is the one this person was last in.
 *
 * On the device rather than on the account, like everything else here: where
 * somebody left off is a habit of that browser, and following them across
 * machines would be a surprise rather than a service.
 */
export function lastChannelIn(spaceId: string): string | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(LAST_CHANNEL_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) return null;
        const found = (parsed as Record<string, unknown>)[spaceId];
        return typeof found === "string" ? found : null;
    } catch {
        return null;
    }
}

export function rememberChannel(spaceId: string, channelId: string): void {
    if (typeof window === "undefined") return;
    try {
        const raw = window.localStorage.getItem(LAST_CHANNEL_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        const map = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string>) : {};
        map[spaceId] = channelId;
        window.localStorage.setItem(LAST_CHANNEL_KEY, JSON.stringify(map));
    } catch {
        // Storage disabled or full. The space still opens - on its first
        // channel, which is where somebody who has never been in it lands.
    }
}

/**
 * Whatever is stored, or nothing.
 *
 * Local storage is editable by whoever owns the browser and survives a build
 * that changed the shape of what is kept, so anything unreadable is treated as
 * absent rather than allowed to throw inside a picker somebody is typing into.
 */
function read<T>(key: string): T[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as T[]).slice(0, KEEP) : [];
    } catch {
        return [];
    }
}

function write<T>(key: string, value: T[]): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Storage disabled, or full. The picker still works; it simply does not
        // remember, which is the right thing to lose.
    }
}
