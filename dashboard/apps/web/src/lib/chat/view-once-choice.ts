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

/** Whether a file can be sent to be seen once: a photo or a video, and nothing else. */
export function viewOnceable(contentType: string): boolean {
    return /^(image|video)\//i.test(contentType);
}
