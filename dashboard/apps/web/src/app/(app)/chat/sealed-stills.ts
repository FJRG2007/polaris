"use client";

/**
 * Stills for sealed videos. A plain video's still is taken by the sender and
 * uploaded beside it; a sealed one has none on the server (it would be a
 * picture of the video in the clear), so the reader's page takes it from the
 * bytes it already opened, once per file, up to a few hundred per page.
 */

import { posterFor } from "./video-poster";
import { isWatchableVideo } from "@/lib/mime";
import type { SealedFileRef } from "@/lib/chat/e2ee/sealed-chat";

/** How many stills a page takes (a few kilobytes each); past it a sealed video draws its blur, as before. */
const KEPT_STILLS = 300;

const stills = new Map<string, string | null>();
const taking = new Map<string, Promise<string | null>>();

/** The still taken here for a sealed video, if one was. */
export function sealedStill(id: string): string | undefined {
    return stills.get(id) ?? undefined;
}

/** Whether this page already took (or tried to take) a sealed video's still; one in progress counts. */
export function stillTried(id: string): boolean {
    return stills.has(id) || taking.has(id);
}

/** Whether a still is worth taking for this sealed file: a video this browser plays. */
export function wantsStill(ref: SealedFileRef): boolean {
    return isWatchableVideo(ref.type);
}

/** Take the still of a sealed video from its opened bytes at `url`; null when the browser gives no frame. */
export function takeSealedStill(ref: SealedFileRef, url: string): Promise<string | null> {
    if (stills.has(ref.id)) return Promise.resolve(stills.get(ref.id) ?? null);
    const running = taking.get(ref.id);
    if (running) return running;
    if (stills.size >= KEPT_STILLS) return Promise.resolve(null);
    const work = (async () => {
        try {
            const bytes = await (await fetch(url)).blob();
            const frame = await posterFor(new File([bytes], ref.name, { type: ref.type }));
            const still = frame ? URL.createObjectURL(frame) : null;
            stills.set(ref.id, still);
            return still;
        } catch {
            stills.set(ref.id, null);
            return null;
        } finally {
            taking.delete(ref.id);
        }
    })();
    taking.set(ref.id, work);
    return work;
}
