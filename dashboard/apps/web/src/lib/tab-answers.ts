/**
 * Answers handed between the tabs of one browser, so a question one tab asked
 * the server is not asked again by every other tab showing the same thing.
 *
 * Two windows on the same screen used to poll it twice, and ten tabs ten times:
 * every one of them paid for a request whose answer another tab had just been
 * given. Here a tab that gets an answer posts it on a BroadcastChannel, and the
 * others take it as their own and put their next request back - the server is
 * asked about as often as one tab would ask it.
 *
 * Only what the server already answered travels; nothing here decides anything.
 * A tab that hears nothing - no BroadcastChannel, no signed-in account, or simply
 * no other tab - asks the server exactly as it did before.
 *
 * Kept to the tabs that should agree:
 *
 * - **The same account.** The channel is named under the session scope, so a tab
 *   left open on a previous account never feeds the current one.
 * - **The same build.** A tab left open across an update runs the old bundle,
 *   and what it read is shaped the way that bundle expected. The channel carries
 *   the build's stamp in its name, so the two never hear each other.
 *
 * What arrives is still checked for its envelope, never trusted for more: the
 * value inside is whatever the posting tab's own read returned.
 */

import { z } from "zod";
import { openPeerChannel } from "@/lib/shared-stream";

const BUILD = process.env.NEXT_PUBLIC_POLARIS_BUILD_STAMP ?? "dev";

const answerSchema = z.object({ kind: z.literal("answer"), at: z.number().finite(), value: z.unknown() });

export interface TabAnswers<T> {
    /** Hand an answer to the other tabs. One that cannot be copied between
     *  tabs (a function, a class instance) is simply not shared. */
    post: (value: T, at: number) => void;
    close: () => void;
}

/**
 * Follow the answers other tabs get for `key`. Null when there is nobody to
 * share with: outside a signed-in page, or in a browser without the channel.
 */
export function openTabAnswers<T>(
    key: string,
    scope: string,
    onAnswer: (value: T, at: number) => void
): TabAnswers<T> | null {
    if (!scope || typeof BroadcastChannel === "undefined") return null;
    const channel = openPeerChannel<z.infer<typeof answerSchema>>(`answers:${BUILD}:${key}`, scope, (message) => {
        const answer = answerSchema.safeParse(message);
        if (answer.success) onAnswer(answer.data.value as T, answer.data.at);
    });
    return {
        post: (value, at) => {
            try {
                channel.post({ kind: "answer", at, value });
            } catch {
                // Not structured-cloneable. This tab keeps its answer; the
                // others ask for their own, as they would have anyway.
            }
        },
        close: channel.close
    };
}

/** How much later than its period a tab may take its turn. */
const SPREAD = 0.25;

/**
 * How long to wait before a tab's next turn, spread a little.
 *
 * Two tabs that started together tick together: each asks, each hears the
 * other's answer a moment after its own, and neither ever gets to skip. A
 * different wait in each puts one of them first, the other hears it before its
 * own turn comes and skips, and from then on that tab is the one asking.
 */
export function spreadDelay(intervalMs: number): number {
    return Math.round(intervalMs * (1 + Math.random() * SPREAD));
}

/**
 * Whether another tab was given an answer since this tab's last turn could
 * have been due - the longest wait `spreadDelay` gives - so asking now would
 * only repeat it. A tab whose peers all went quiet or hidden stops hearing
 * anything and, one period later, asks for itself.
 */
export function heardRecently(heardAt: number, intervalMs: number, now = Date.now()): boolean {
    return heardAt > 0 && now - heardAt < intervalMs * (1 + SPREAD);
}
