"use client";

/**
 * The pictures beside the one open in Drive's preview, fetched before anybody
 * steps to them.
 *
 * Arrowing through photos on a slow line waited for each one from its first
 * byte. Now the preview asks for the next few while the current one is looked
 * at, and a step lands on bytes already in the browser - the way every photo
 * viewer reads ahead.
 *
 * Held as blobs rather than left to the HTTP cache: the download route sends no
 * caching headers (it serves whatever is on the storage, to one session), so a
 * second request for the same address would go back to the server. The fetch
 * is marked `purpose=preload`, which the route records as a preload rather than
 * a view; showing a cached picture then records the view itself
 * (`recordView`), so Recent and the activity panel list what was opened, not
 * what was read ahead.
 *
 * Bounded: a few pictures in each direction, the oldest let go (and its object
 * URL revoked) once more than `KEPT` are held, and nothing over `LARGEST` bytes,
 * which would cost more to hold than to fetch when it is reached.
 */

/** Pictures held at once. Enough for a few steps either way. */
const KEPT = 8;

/** The largest file read ahead. A 40 MB RAW is not worth guessing at. */
export const LARGEST = 25 * 1024 * 1024;

interface Held {
    url: string | null;
    controller: AbortController;
}

const held = new Map<string, Held>();

function preloadAddress(src: string): string {
    return `${src}${src.includes("?") ? "&" : "?"}purpose=preload`;
}

function evict(): void {
    while (held.size > KEPT) {
        const [oldest, entry] = held.entries().next().value as [string, Held];
        entry.controller.abort();
        if (entry.url) URL.revokeObjectURL(entry.url);
        held.delete(oldest);
    }
}

/** Start fetching a picture, unless it is held or on its way already. */
export function preloadPicture(src: string): void {
    if (held.has(src) || typeof fetch !== "function") return;
    const entry: Held = { url: null, controller: new AbortController() };
    held.set(src, entry);
    evict();
    void fetch(preloadAddress(src), { signal: entry.controller.signal, credentials: "same-origin" })
        .then(async (response) => {
            if (!response.ok) throw new Error(String(response.status));
            const blob = await response.blob();
            if (held.get(src) !== entry) return;
            entry.url = URL.createObjectURL(blob);
        })
        .catch(() => {
            // Offline, refused, or let go: the preview fetches it itself on arrival.
            if (held.get(src) === entry) held.delete(src);
        });
}

/** The picture's bytes in this browser, as an address an <img> can show, or
 *  null when they have not arrived. */
export function cachedPicture(src: string): string | null {
    const entry = held.get(src);
    if (!entry?.url) return null;
    // Recently used goes to the back of the line.
    held.delete(src);
    held.set(src, entry);
    return entry.url;
}

/**
 * Record that a picture shown from the cache was opened: one byte of it,
 * asked for the way the preview would have asked, so the server writes the same
 * view it writes for a picture fetched on arrival. Let go once answered.
 */
export function recordView(src: string): void {
    if (typeof fetch !== "function") return;
    const controller = new AbortController();
    void fetch(src, {
        headers: { range: "bytes=0-0" },
        signal: controller.signal,
        credentials: "same-origin"
    })
        .then(() => controller.abort())
        .catch(() => undefined);
}

/** Forget everything held. */
export function dropPictures(): void {
    for (const entry of held.values()) {
        entry.controller.abort();
        if (entry.url) URL.revokeObjectURL(entry.url);
    }
    held.clear();
}
