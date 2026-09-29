/**
 * The name a copy of a channel is offered: the original's with the first number
 * nobody in the space has used, so the dialog opens on a name it will accept.
 */

import * as core from "@polaris/core";

/** The original's name with the first number free in its space. */
export function freeCopyName(name: string, taken: ReadonlySet<string>): string {
    for (let number = 2; ; number++) {
        // The number is kept whole at the length limit: cut after it, a long
        // name would come back as itself on every turn and never be free.
        const suffix = `-${number}`;
        const base = core
            .normalizeChannelName(name)
            .slice(0, core.MAX_CHAT_CHANNEL_NAME - suffix.length);
        const candidate = core.normalizeChannelName(`${base}${suffix}`);
        if (!taken.has(candidate)) return candidate;
    }
}
