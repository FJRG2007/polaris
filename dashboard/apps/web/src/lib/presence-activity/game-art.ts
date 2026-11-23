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
import * as core from "@polaris/core";
import { fetchImage, follow, readCapped } from "@/lib/safe-fetch";
import { MAX_ART_BYTES, MAX_METADATA_BYTES, artRefFor, artUrlFrom, metadataUrl, resolvable } from "./game-art-sources";

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

async function fromStore(ref: string): Promise<Uint8Array | null> {
    const address = metadataUrl(ref);
    if (!address) return null;
    const response = await follow(new URL(address), "application/json", undefined, 10_000);
    if (!response?.ok) return null;
    const raw = await readCapped(response, MAX_METADATA_BYTES);
    if (!raw) return null;
    let body: unknown;
    try {
        body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
        return null;
    }
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
    if (!core.GAME_STORE_REF.test(ref) || !resolvable(ref)) return null;
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

/** Start fetching a picture before the first reader asks, so their card is not the one that waits. */
export function warmGameArt(ref: string): void {
    void gameArt(ref).catch(() => undefined);
}
