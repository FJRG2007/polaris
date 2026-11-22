"use server";

import { requirePermission } from "@/lib/session";
import { loadChatPreferences, saveChatPreferences } from "@/lib/chat/preferences";
import { CAPTION_POSITIONS, type ChatPreferences } from "@/lib/chat/preference-schema";
import { z } from "zod";

/** The Chat settings of the account signed in, and nobody else's. */
export async function chatPreferencesAction(): Promise<ChatPreferences> {
    const user = await requirePermission("chat.use");
    return loadChatPreferences(user.id);
}

/** Where a message's text goes when it came with pictures, for this reader. */
export async function setCaptionPositionAction(
    raw: unknown
): Promise<ChatPreferences | { error: string }> {
    const user = await requirePermission("chat.use");
    const parsed = z.enum(CAPTION_POSITIONS).safeParse(raw);
    if (!parsed.success) return { error: "invalid" };
    return saveChatPreferences(user.id, { captionPosition: parsed.data });
}
