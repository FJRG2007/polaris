/**
 * One person's Chat settings: the schema, the defaults and the forgiving read.
 *
 * Kept free of the database so the chat screens can read a cached copy with the
 * same rules the server applies. Reading fills every missing or unreadable
 * field with its default, so a setting added later is there for everybody with
 * no row to migrate; writing is strict (`chatPreferencesSchema`).
 */

import { z } from "zod";

/** Where a message's text goes when it came with pictures or videos: above
 *  them, as Discord draws it, or under them, as WhatsApp does. */
export const CAPTION_POSITIONS = ["above", "below"] as const;

export type CaptionPosition = (typeof CAPTION_POSITIONS)[number];

const fields = {
    captionPosition: z.enum(CAPTION_POSITIONS)
};

export const chatPreferencesSchema = z.object(fields);

export type ChatPreferences = z.infer<typeof chatPreferencesSchema>;

export const DEFAULT_CHAT_PREFERENCES: ChatPreferences = { captionPosition: "above" };

/** Every field present and valid, whatever the stored document holds. Takes
 *  the stored JSON text or an already parsed value. */
export function readChatPreferences(raw: unknown): ChatPreferences {
    let parsed: unknown = raw;
    if (typeof raw === "string") {
        try {
            parsed = JSON.parse(raw);
        } catch {
            parsed = {};
        }
    }
    const value = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
    const captionPosition = fields.captionPosition.safeParse(value.captionPosition);
    return {
        captionPosition: captionPosition.success
            ? captionPosition.data
            : DEFAULT_CHAT_PREFERENCES.captionPosition
    };
}

/** Whether a message's text is drawn under its attachments for this reader:
 *  only when they chose "below" and there is both text and something visual. */
export function captionGoesBelow(
    position: CaptionPosition,
    message: { readonly body: string; readonly attachments: readonly { readonly contentType: string }[] }
): boolean {
    if (position !== "below" || !message.body.trim()) return false;
    return message.attachments.some(
        (file) => file.contentType.startsWith("image/") || file.contentType.startsWith("video/")
    );
}
