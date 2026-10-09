/**
 * One write, with a refusal turned into a sentence.
 *
 * A refusal from the chat's access layer is an answer rather than a fault - the
 * screen that asked has somewhere to put it - so it comes back as `{ error }` in
 * the reader's language, the way a failed validation does. Anything else is a
 * real fault and is left to throw.
 *
 * Shared by every module of chat actions, which each had a copy of it.
 *
 * Server-only.
 */

import { ChatAccessError } from "./access";
import { getLocale } from "@/lib/i18n/request";

export async function guardChat<T>(run: () => Promise<T>): Promise<{ value?: T; error?: string }> {
    try {
        return { value: await run() };
    } catch (caught) {
        if (caught instanceof ChatAccessError) return { error: caught.textIn(await getLocale()) };
        throw caught;
    }
}
