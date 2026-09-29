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

import type * as core from "@polaris/core";
import { translate } from "@/lib/i18n/translate";
import type { NamespaceKey } from "@/lib/i18n/types";

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
