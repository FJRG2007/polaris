/**
 * One person's Chat settings, stored as one JSON document (`ChatPreference`).
 *
 * An account that never changed anything has no row at all; the defaults live
 * in `preference-schema.ts`, so an existing install needs no setup.
 */

import { prisma } from "@polaris/db";
import { chatPreferencesSchema, readChatPreferences, type ChatPreferences } from "./preference-schema";

export async function loadChatPreferences(userId: string): Promise<ChatPreferences> {
    const row = await prisma.chatPreference.findUnique({
        where: { userId },
        select: { value: true }
    });
    return readChatPreferences(row?.value);
}

/** Apply a change and answer the settings as they now read. A change that
 *  leaves every value as it was writes nothing. */
export async function saveChatPreferences(
    userId: string,
    patch: Partial<ChatPreferences>
): Promise<ChatPreferences> {
    const current = await loadChatPreferences(userId);
    const next = chatPreferencesSchema.parse({ ...current, ...patch });
    if (next.captionPosition === current.captionPosition) return current;
    const value = JSON.stringify(next);
    await prisma.chatPreference.upsert({
        where: { userId },
        create: { userId, value },
        update: { value }
    });
    return next;
}
