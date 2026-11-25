"use server";

/**
 * The namespaces a client screen drawn outside its own route asks for - one an
 * installable app embeds, whose route no server layout of ours wraps. Only the
 * namespaces named here can be asked for.
 */

import { z } from "zod";
import { getLocale } from "@/lib/i18n/request";
import { pickMessages } from "@/lib/i18n/translate";
import { logMissingMessage } from "@/lib/i18n/fallback";
import { webCatalogs } from "../../../messages";
import { mergeCatalog, SOURCE_LOCALE, type Namespaces } from "@polaris/core";

const askable = z
    .array(z.enum(["automations", "agents", "driveViewer"]))
    .min(1)
    .max(4);

export async function namespaceMessagesAction(names: unknown) {
    const parsed = askable.safeParse(names);
    if (!parsed.success) return null;
    const locale = await getLocale();
    return { locale, messages: pickMessages(locale, parsed.data) };
}

const KNOWN = new Set<string>(webCatalogs.namespaces);

const rescue = z.object({
    names: z.array(z.string().refine((name) => KNOWN.has(name))).max(4),
    keys: z
        .array(z.string().regex(/^[A-Za-z0-9_.-]{1,200}$/))
        .max(40)
});

/**
 * A production screen's safety net (BUG-0037): the namespaces a screen
 * translated with and was never handed, in the reader's language over the
 * source's, so nothing is drawn as a key; and the keys it could not find, logged
 * here once each so the miss is seen by whoever runs the server.
 */
export async function rescueMessagesAction(names: unknown, keys: unknown) {
    const parsed = rescue.safeParse({ names, keys });
    if (!parsed.success) return null;
    for (const key of parsed.data.keys) logMissingMessage(key, "browser");
    const locale = await getLocale();
    const own = webCatalogs.pick(locale, parsed.data.names as never);
    const source = webCatalogs.pick(SOURCE_LOCALE, parsed.data.names as never);
    const messages: Record<string, Namespaces[string]> = {};
    for (const name of parsed.data.names) {
        const base = source[name];
        if (base) messages[name] = mergeCatalog(base, own[name]);
    }
    return { locale, messages };
}
