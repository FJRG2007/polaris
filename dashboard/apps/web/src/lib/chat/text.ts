/**
 * Words decided on the server and said later, in whoever's language reads them.
 *
 * A refusal is decided deep in the chat service, which has no idea who is
 * reading; the action or route that answers does. So the service hands back a
 * key and its values (`ChatText`), and the answering layer turns it into a
 * sentence with the reader's locale. A value may itself be a `ChatText` - a
 * length of time, say - and is translated in the same language first, so no
 * English fragment ends up inside a Spanish sentence.
 */

import * as core from "@polaris/core";
import { translate, translatorFor } from "@/lib/i18n/translate";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

/** A message of the `chat` catalog and its values. */
export interface ChatText<K extends NamespaceKey<"chat"> = NamespaceKey<"chat">> {
    readonly key: K;
    readonly params?: Readonly<Record<string, core.MessageValue | ChatText>>;
}

function isChatText(value: unknown): value is ChatText {
    return typeof value === "object" && value !== null && "key" in value;
}

/** A `ChatText` as a sentence in one language. */
export function chatText(locale: core.Locale, text: ChatText): string {
    const params = text.params
        ? Object.fromEntries(
              Object.entries(text.params).map(([name, value]) => [
                  name,
                  isChatText(value) ? chatText(locale, value) : value
              ])
          )
        : undefined;
    return translate(locale, `chat.${text.key}`, params);
}

/**
 * The chat catalog in one person's language, for words written now and read by
 * them later - a notification, a call's title.
 *
 * The locale service is loaded when asked for rather than at the top, because
 * the modules that call this also run in jobs and tests that never load the
 * session; where it cannot load, or the person cannot be read, the default
 * language answers rather than the message going unsent.
 */
export async function chatWordsFor(userId: string): Promise<NamespaceTranslator<"chat">> {
    try {
        const { getUserLocale } = await import("@/lib/i18n/locale-service");
        return translatorFor(await getUserLocale(userId), "chat");
    } catch {
        return translatorFor(core.DEFAULT_LOCALE, "chat");
    }
}
