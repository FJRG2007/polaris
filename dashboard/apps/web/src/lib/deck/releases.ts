/**
 * The newest released Stream Deck plugin and Companion module, for a deck to
 * compare its own version with.
 *
 * Read through `app-releases`, whose two-minute cache is shared with the
 * Downloads screen, so a room full of decks costs GitHub no more than one
 * screen does. The catalogue a deck asks for waits on this, so the lookup gets
 * a short head start and no more: past it the deck is told nothing this time,
 * the lookup carries on into the cache, and its next catalogue has the answer.
 */

import * as releases from "@/lib/app-releases";

/** Where a deck sends somebody to fetch the newer file. */
export const DOWNLOADS_PATH = "/account/downloads";

/** How long a catalogue waits on GitHub before it answers without the versions. */
const WAIT_MS = 1500;

export interface DeckReleases {
    /** The newest plugin release as `x.y.z`, or null when none is known. */
    readonly streamdeck: string | null;
    /** The newest Companion module release as `x.y.z`, or null when none is known. */
    readonly companion: string | null;
    /** The page of this Polaris that offers both. */
    readonly downloadsPath: string;
}

function within<T>(lookup: Promise<T>, waitMs: number, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), waitMs)));
    return Promise.race([lookup.catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

export async function deckReleases(repo: string, waitMs = WAIT_MS): Promise<DeckReleases> {
    const [streamdeck, companion] = await Promise.all([
        within(releases.streamDeckDownload(repo), waitMs, null),
        within(releases.companionDownload(repo), waitMs, null)
    ]);
    return {
        streamdeck: streamdeck?.version ?? null,
        companion: companion?.version ?? null,
        downloadsPath: DOWNLOADS_PATH
    };
}
