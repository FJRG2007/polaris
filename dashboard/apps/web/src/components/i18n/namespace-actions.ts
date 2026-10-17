"use server";

/**
 * The namespaces a client screen drawn outside its own route asks for - one an
 * installable app embeds, whose route no server layout of ours wraps. Only the
 * namespaces named here can be asked for.
 */

import { z } from "zod";
import { getLocale } from "@/lib/i18n/request";
import { pickMessages } from "@/lib/i18n/translate";

const askable = z.array(z.enum(["automations"])).min(1).max(4);

export async function namespaceMessagesAction(names: unknown) {
    const parsed = askable.safeParse(names);
    if (!parsed.success) return null;
    const locale = await getLocale();
    return { locale, messages: pickMessages(locale, parsed.data) };
}
