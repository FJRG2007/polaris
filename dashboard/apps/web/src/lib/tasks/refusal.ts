/**
 * A write Tasks turned down for a reason the person can act on - "That list no
 * longer exists", "A sprint has to end after it starts".
 *
 * It carries the catalog key rather than only the sentence, because the service
 * that refuses does not know who is reading: the action that catches it
 * translates the key in the reader's language (`refusalText`). The message is
 * the English, so a log line, a test, or a caller that only reads `.message`
 * (an MCP tool, the public API) sees exactly what it always did.
 */

import { translate } from "@/lib/i18n/translate";
import { DEFAULT_LOCALE, type MessageParams } from "@polaris/core";
import type { NamespaceKey, NamespaceTranslator, WebKey } from "@/lib/i18n/types";

export type TaskRefusalKey = Extract<NamespaceKey<"tasks">, `refusals.${string}`>;

export class TaskRefusal extends Error {
    constructor(
        readonly key: TaskRefusalKey,
        readonly params?: MessageParams
    ) {
        super(translate(DEFAULT_LOCALE, `tasks.${key}` as WebKey, params));
        this.name = "TaskRefusal";
    }
}

/** The refusal in the reader's words, or null when `caught` is not one. */
export function refusalText(t: NamespaceTranslator<"tasks">, caught: unknown): string | null {
    return caught instanceof TaskRefusal ? t(caught.key, caught.params) : null;
}

/** Core's reasons a folder cannot be dropped somewhere (`folderMoveRefusal`),
 *  English there because core has no reader, as refusals here. */
export function folderMoveRefusal(reason: string, depthLimit: number): TaskRefusal {
    if (reason === "A folder cannot be moved into itself") return new TaskRefusal("refusals.folderIntoItself");
    if (reason === "A folder cannot be moved into one of its own subfolders")
        return new TaskRefusal("refusals.folderIntoSubfolder");
    return new TaskRefusal("refusals.folderTooDeepMove", { limit: depthLimit });
}
