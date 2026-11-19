/**
 * What a sender chooses for a file sent to be seen once, read the same way by
 * the composer and by the route that stores the message. Safe for the browser:
 * the server half is `view-once.ts`.
 */

import { z } from "zod";

/** The timer choices a sender has: a few seconds, half a minute, or until closed. */
export const VIEW_SECONDS = [1, 2, 3, 5, 10, 30] as const;
/** What a photo is sent with when the sender does not choose. */
export const DEFAULT_VIEW_SECONDS = 10;

/** One file of a message sent to be seen once, by its place in the message. */
export const viewOnceChoiceSchema = z.object({
    index: z.number().int().min(0).max(99),
    seconds: z
        .number()
        .int()
        .refine((value) => (VIEW_SECONDS as readonly number[]).includes(value))
        .nullable(),
    captured: z.enum(["camera", "gallery"]).nullable().optional()
});

export const viewOnceChoicesSchema = z.array(viewOnceChoiceSchema).max(10);

export type ViewOnceChoice = z.infer<typeof viewOnceChoiceSchema>;

/** The form field the composer sends, read strictly: anything malformed is no choice at all. */
export function readViewOnceChoices(raw: unknown): ViewOnceChoice[] {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 4_000) return [];
    try {
        const parsed = viewOnceChoicesSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : [];
    } catch {
        return [];
    }
}

/** Whether a file can be sent to be seen once: a photo, a video or a recording, and nothing else. */
export function viewOnceable(contentType: string): boolean {
    return /^(image|video|audio)\//i.test(contentType);
}

/**
 * A text message sent to be seen once travels as a small file, so the opening,
 * the records of who opened it and the purge are exactly those of a photo. The
 * message itself carries no text; this is all there is of it.
 */
export const VIEW_ONCE_TEXT_TYPE = "text/plain";
/** The one name it is stored under, so no line that shows file names says anything. */
export const VIEW_ONCE_TEXT_NAME = "message.txt";
/** The most a view-once text may weigh: a long message, never a document. */
export const MAX_VIEW_ONCE_TEXT_BYTES = 4096;

/** Whether this is the file a view-once text message travels as. */
export function viewOnceText(contentType: string): boolean {
    return /^text\/plain(\s*;.*)?$/i.test(contentType.trim());
}

/** Whether these bytes are a view-once text: not empty, under the cap, and UTF-8. */
export function viewOnceTextBytes(bytes: Uint8Array): boolean {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_VIEW_ONCE_TEXT_BYTES) return false;
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim().length > 0;
    } catch {
        return false;
    }
}

/** A typed message as the file it is sent as, or null when it cannot be one. */
export function viewOnceTextFile(text: string): File | null {
    const body = text.trim();
    if (!body || new TextEncoder().encode(body).byteLength > MAX_VIEW_ONCE_TEXT_BYTES) return null;
    return new File([body], VIEW_ONCE_TEXT_NAME, { type: VIEW_ONCE_TEXT_TYPE });
}

/** What the route stores a view-once choice against, and how it arrived. */
export type ViewOnceTarget = {
    readonly contentType: string;
    readonly borrowed: boolean;
    /** The bytes, when they came in the request itself; null for a streamed upload. */
    readonly inForm: Uint8Array | null;
};

/**
 * Whether a file may be sent to be seen once: a photo, a video or a recording
 * the conversation holds, or a view-once text that came in the request itself,
 * where its size and encoding can be read before anything is stored.
 */
export function viewOnceAllowed(target: ViewOnceTarget): boolean {
    if (target.borrowed) return false;
    if (viewOnceText(target.contentType)) return target.inForm !== null && viewOnceTextBytes(target.inForm);
    return viewOnceable(target.contentType);
}
