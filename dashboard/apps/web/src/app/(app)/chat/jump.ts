/**
 * Following a link to one message: a notice, a search hit, a quote, an address.
 *
 * Kept out of the screen so the order of it can be asserted. The order is the
 * whole of the fix it carries: the screen opens on the copy this device kept,
 * which predates whatever the notice was about, and a jump that looked there and
 * gave up told the reader a message was out of reach a moment before it appeared
 * on screen under the error. So nothing is looked for until the server's own
 * window is in, and nothing is called unreachable until the server says so.
 */

import type { ChatAroundPage, ChatMissingReason } from "@/lib/chat/messages";

/** The window around the target, as the server hands it back. */
export type FoundWindow = Extract<ChatAroundPage, { found: true }>;

/** How a jump ended. `failed` carries the server's own sentence. */
export type JumpOutcome =
    | { readonly kind: "landed" }
    | { readonly kind: "thread" }
    | { readonly kind: "missing"; readonly reason: Exclude<ChatMissingReason, "reply"> }
    | { readonly kind: "failed"; readonly error: string };

/** What the screen lends the jump. */
export interface JumpSteps {
    /** Settles once the window on screen came from the server, not the device. */
    readonly fresh: () => Promise<void>;
    /** Settles once what was just put in the window is in the document. */
    readonly drawn: () => Promise<void>;
    /** Scroll to the message and light it, when it is drawn. */
    readonly landOn: (messageId: string) => boolean;
    readonly readAround: (messageId: string) => Promise<{ page?: ChatAroundPage; error?: string }>;
    /** Swap the window for the one around the target. */
    readonly showWindow: (window: FoundWindow) => void;
    /** Open the thread a reply lives in. Answers whether it did. */
    readonly openThread: (messageId: string) => Promise<boolean>;
}

/**
 * Land on a message, however old.
 *
 * Already in the server's window: scrolled to. Anywhere else in the
 * conversation: one read of the page around it, which the screen swaps in and
 * scrolls on from in both directions. A reply: its thread. Otherwise the
 * server's reason, for the screen to put in words.
 */
export async function jumpToMessage(messageId: string, steps: JumpSteps): Promise<JumpOutcome> {
    await steps.fresh().catch(() => undefined);
    await steps.drawn();
    if (steps.landOn(messageId)) return { kind: "landed" };

    const answer = await steps.readAround(messageId);
    if (!answer.page) return { kind: "failed", error: answer.error ?? "" };
    const page = answer.page;
    if (page.found) {
        steps.showWindow(page);
        await steps.drawn();
        return steps.landOn(messageId) ? { kind: "landed" } : { kind: "missing", reason: "missing" };
    }
    if (page.reason === "reply")
        return (await steps.openThread(messageId)) ? { kind: "thread" } : { kind: "missing", reason: "missing" };
    return { kind: "missing", reason: page.reason };
}
