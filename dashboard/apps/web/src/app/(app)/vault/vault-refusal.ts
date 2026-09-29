/**
 * A vault action's refusal, in the language of whoever made the request.
 *
 * Only the actions use this - it reads the request - and they hand back the
 * sentence rather than a key, because the screens show `result.error` as it
 * comes.
 */

import { vaultSchemaText } from "./vault-labels";
import type { MessageParams } from "@polaris/core";
import { getTranslations } from "@/lib/i18n/request";
import type { NamespaceKey } from "@/lib/i18n/types";

export async function vaultRefusal(key: NamespaceKey<"vault">, params?: MessageParams): Promise<string> {
    return (await getTranslations("vault"))(key, params);
}

/** A schema's first complaint in the reader's words, or the fallback when it
 *  had none to give. */
export async function schemaRefusal(message: string | undefined, fallback: NamespaceKey<"vault">): Promise<string> {
    if (message === undefined) return vaultRefusal(fallback);
    return vaultSchemaText(await getTranslations("vault"), await getTranslations("validation"), message);
}
