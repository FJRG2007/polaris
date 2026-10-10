"use client";

/**
 * How the presenter view and the audience window keep to one slide.
 *
 * PowerPoint for the web's presenter view: the notes, the timer and the next
 * slide stay on the presenter's screen, and the slide itself opens in a window
 * of its own to be dragged onto the projector. Both are this browser and this
 * deck, so they talk over a `BroadcastChannel` - same origin only, nothing
 * leaves the machine - and the presenter's tab is the one that decides: the
 * audience window says where it would like to go and shows where it is told.
 */

import { z } from "zod";

const message = z.discriminatedUnion("kind", [
    /** The presenter: this is the slide (one past the last is the end screen),
     *  and how many of its animation steps have played. */
    z.object({
        kind: z.literal("at"),
        at: z.number().int().min(0).max(100_000),
        played: z.number().int().min(0).max(100_000).default(0)
    }),
    /** The presenter: the show is over; the audience window closes. */
    z.object({ kind: z.literal("end") }),
    /** The audience window: it has just opened and wants to know the slide. */
    z.object({ kind: z.literal("hello") }),
    /** The audience window: somebody pressed a key or clicked on it. */
    z.object({ kind: z.literal("go"), to: z.enum(["next", "previous", "first", "last"]) })
]);

export type ShowMessage = z.infer<typeof message>;

/** Whether this browser can keep two windows on one slide - decided in the
 *  browser, after mount, so a control for it is only ever offered where it
 *  works. */
export function canOpenAudienceWindow(): boolean {
    return typeof BroadcastChannel === "function" && typeof window.open === "function";
}

export function audiencePath(documentId: string): string {
    return `/office/show/${encodeURIComponent(documentId)}`;
}

export interface ShowChannel {
    send(one: ShowMessage): void;
    close(): void;
}

/** The channel for one deck's show; `onMessage` hears the other window. */
export function openShowChannel(
    documentId: string,
    onMessage: (one: ShowMessage) => void
): ShowChannel | null {
    if (typeof BroadcastChannel !== "function") return null;
    const channel = new BroadcastChannel(`polaris.office.show.${documentId}`);
    channel.onmessage = (event: MessageEvent) => {
        const read = message.safeParse(event.data);
        if (read.success) onMessage(read.data);
    };
    return {
        send: (one) => channel.postMessage(one),
        close: () => channel.close()
    };
}
