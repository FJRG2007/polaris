/**
 * A game's picture, as this server keeps it: fetched once from the store that
 * sells the game (`game-art-sources.ts`), through the guarded fetch, decoded and
 * redrawn as a 128px WebP, stored, and served to every reader from here - so a
 * store never learns who looked, and nothing a computer sent is ever drawn.
 *
 * One fetch per game per server: a stored answer (a picture, or "the store has
 * none") is kept, and readers asking at once share the one fetch in flight.
 */

import { prisma } from "@polaris/db";
import { rateLimit } from "@/lib/rate-limit-service";
import { fetchImage, follow, readCapped } from "@/lib/safe-fetch";
import { MAX_ART_BYTES, MAX_METADATA_BYTES, artRefFor, artUrlFrom, metadataUrl, resolvable } from "./game-art-sources";
import { lookupByName, nameOfRef } from "./game-art-lookup";

/** The side of the square every picture is redrawn at. */
export const ART_SIDE = 128;

/** Anything this many pixels or more is not a game's box art. */
const MAX_ART_PIXELS = 40 * 1024 * 1024;

/** A picture is asked for again after this, in case the store changed it. */
const ART_FRESH_MS = 30 * 24 * 60 * 60_000;

/** A store that had nothing, or did not answer, is asked again after this. */
const MISSING_RETRY_MS = 24 * 60 * 60_000;

/** The fetches in flight, so readers asking at once share one. */
const inFlight = new Map<string, Promise<Uint8Array | null>>();

/** A store's picture redrawn as the square every card draws, or null when it is not a picture. */
export async function redraw(bytes: Uint8Array): Promise<Uint8Array | null> {
    try {
        const { default: sharp } = await import("sharp");
        return new Uint8Array(
            await sharp(bytes, { limitInputPixels: MAX_ART_PIXELS })
                .rotate()
                .resize(ART_SIDE, ART_SIDE, { fit: "cover", position: "attention" })
                .webp({ quality: 85 })
                .toBuffer()
        );
    } catch {
        return null;
    }
}

/** A store's JSON answer through the guarded fetch, or undefined when it gave none. */
async function storeJson(address: string): Promise<unknown | undefined> {
    const response = await follow(new URL(address), "application/json, application/sparql-results+json", undefined, 10_000);
    if (!response?.ok) {
        await response?.body?.cancel().catch(() => undefined);
        return undefined;
    }
    const raw = await readCapped(response, MAX_METADATA_BYTES);
    if (!raw) return undefined;
    try {
        return JSON.parse(new TextDecoder().decode(raw)) as unknown;
    } catch {
        return undefined;
    }
}

async function fromStore(ref: string): Promise<Uint8Array | null> {
    const address = metadataUrl(ref);
    if (!address) return null;
    const body = await storeJson(address);
    if (body === undefined) return null;
    const art = artUrlFrom(ref, body);
    if (!art) return null;
    const image = await fetchImage(art, MAX_ART_BYTES);
    return image ? redraw(image.bytes) : null;
}

async function fetchAndKeep(ref: string): Promise<Uint8Array | null> {
    const image = await fromStore(ref).catch(() => null);
    const row = { image: image ? Buffer.from(image) : null, fetchedAt: new Date() };
    await prisma.gameArt
        .upsert({ where: { ref }, create: { ref, ...row }, update: row })
        .catch(() => undefined);
    return image;
}

/**
 * The picture for this store id: the kept one, or fetched now when none is kept
 * or the kept answer is old. Null when the store has none, or is not one asked.
 */
export async function gameArt(ref: string, now: Date = new Date()): Promise<Uint8Array | null> {
    if (!resolvable(ref)) return null;
    const kept = await prisma.gameArt.findUnique({ where: { ref }, select: { image: true, fetchedAt: true } });
    const age = kept ? now.getTime() - kept.fetchedAt.getTime() : Infinity;
    if (kept?.image && age < ART_FRESH_MS) return new Uint8Array(kept.image);
    if (kept && !kept.image && age < MISSING_RETRY_MS) return null;
    const running = inFlight.get(ref);
    if (running) return running;
    const next = fetchAndKeep(ref).finally(() => inFlight.delete(ref));
    inFlight.set(ref, next);
    const fresh = await next;
    // A store that stopped answering keeps the picture it last gave.
    return fresh ?? (kept?.image ? new Uint8Array(kept.image) : null);
}

/**
 * The store id a reported game is drawn by, learning it for the program when
 * the computer said one, so the same game reported later by a desktop app that
 * does not know its store is drawn too. The first desktop app to say wins: a
 * later one cannot repaint a game everybody already sees.
 */
export async function artRefOfReport(key: string, reported: string | undefined): Promise<string | null> {
    const learned = await prisma.gameArtKey
        .findUnique({ where: { key }, select: { ref: true } })
        .catch(() => null);
    if (reported && !learned && resolvable(reported)) {
        await prisma.gameArtKey
            .createMany({ data: [{ key, ref: reported }], skipDuplicates: true })
            .catch(() => undefined);
    }
    return artRefFor(key, reported, learned?.ref);
}

/** A name found is asked again after this, in case the store renamed or delisted it. */
const NAME_FRESH_MS = 90 * 24 * 60 * 60_000;

/** A name no source had is asked again after this; one asked longer ago is forgotten. */
const NAME_MISSING_RETRY_MS = 7 * 24 * 60 * 60_000;
const NAME_MISSING_KEEP_MS = 30 * 24 * 60 * 60_000;

/**
 * Lookups this server makes in a window, every reader and game together. Each
 * is up to three requests; Wikidata allows a client a minute of query time a
 * minute and Steam's store search is unmetered but not unlimited, so a burst of
 * new names waits for the next window instead of being remembered as missing.
 */
const LOOKUP_LIMIT = 20;
const LOOKUP_WINDOW_MS = 60_000;

/** The lookups in flight, so readers of the same new game share one. */
const namesInFlight = new Map<string, Promise<string | null>>();

let lastSweep = 0;

/** Forget names nobody has had a store id for in a long time, at most once an hour. */
function sweepMissingNames(now: Date): void {
    if (now.getTime() - lastSweep < 60 * 60_000) return;
    lastSweep = now.getTime();
    void prisma.gameArtName
        .deleteMany({ where: { ref: null, checkedAt: { lt: new Date(now.getTime() - NAME_MISSING_KEEP_MS) } } })
        .catch(() => undefined);
}

async function lookUpAndKeep(name: string, now: Date): Promise<string | null> {
    const allowed = await rateLimit("game-art-lookup", LOOKUP_LIMIT, LOOKUP_WINDOW_MS);
    if (!allowed.ok) return null;
    const found = await lookupByName(name, (url) => storeJson(url)).catch(() => undefined);
    // A source that did not answer is not a source that had nothing: nothing is kept.
    if (!found) return null;
    const row = { ref: found.ref, source: found.source, checkedAt: now };
    await prisma.gameArtName
        .upsert({ where: { name }, create: { name, ...row }, update: row })
        .catch(() => undefined);
    if (!found.ref) sweepMissingNames(now);
    return found.ref;
}

/**
 * The store id of the game this normalized name is, found once per server by
 * the keyless chain (`game-art-lookup.ts`) and kept - a miss too, so a game no
 * store sells is not looked up on every report. Null when none is known.
 */
export async function refForName(name: string, now: Date = new Date()): Promise<string | null> {
    const kept = await prisma.gameArtName
        .findUnique({ where: { name }, select: { ref: true, checkedAt: true } })
        .catch(() => null);
    const age = kept ? now.getTime() - kept.checkedAt.getTime() : Infinity;
    if (kept?.ref && age < NAME_FRESH_MS) return kept.ref;
    if (kept && !kept.ref && age < NAME_MISSING_RETRY_MS) return null;
    const running = namesInFlight.get(name);
    if (running) return running;
    const next = lookUpAndKeep(name, now).finally(() => namesInFlight.delete(name));
    namesInFlight.set(name, next);
    const fresh = await next;
    // A lookup that could not run keeps the id found last time.
    return fresh ?? kept?.ref ?? null;
}

/** The picture for what a card names: a store id, or a game's `name:` to look up first. */
export async function pictureFor(ref: string): Promise<Uint8Array | null> {
    const name = nameOfRef(ref);
    if (name === null) return gameArt(ref);
    const found = await refForName(name);
    return found ? gameArt(found) : null;
}

/** Start fetching a picture - and for a game known only by name, its lookup -
 *  before the first reader asks, so their card is not the one that waits. */
export function warmPicture(ref: string): void {
    void pictureFor(ref).catch(() => undefined);
}
