/**
 * A server action's reply, in the language of the person who pressed the button.
 *
 * Server-only: the Deploy actions import it, never a client component.
 */

import type { MessageParams } from "@polaris/core";
import { getTranslations } from "@/lib/i18n/request";
import { CloudError } from "@/lib/data-cloud/errors";
import type { NamespaceKey } from "@/lib/i18n/types";

type ReplyKey = NamespaceKey<"deployServer">;

export async function reply(key: ReplyKey, params?: MessageParams): Promise<string> {
    return (await getTranslations("deployServer"))(key, params);
}

/**
 * The first problem a schema found, for the screen. A schema written here gives
 * its messages as keys of this namespace (`"issues.nameRequired"`), and a shared
 * one its form's keys in `deploy`, and they are translated; a shared schema's
 * own words pass through as they are.
 */
export async function firstIssue(error: { issues: readonly { message: string }[] }, fallback: ReplyKey): Promise<string> {
    const t = await getTranslations("deployServer");
    const message = error.issues[0]?.message;
    if (!message) return t(fallback);
    if (t.has(message)) return t(message);
    const form = await getTranslations("deploy");
    return form.has(message) ? form(message) : message;
}

/** Why something failed, for the screen: a cloud step's reason in the reader's
 *  language, any other error's own message, or the fallback. */
export async function failure(caught: unknown, fallback: ReplyKey): Promise<string> {
    if (caught instanceof CloudError) return reply(`databases.cloud.${caught.key}`, caught.params);
    return caught instanceof Error ? caught.message : reply(fallback);
}
