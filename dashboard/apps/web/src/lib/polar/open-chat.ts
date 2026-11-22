/**
 * Which chat Polar shows when it opens - the side panel, the extension's
 * panel, or the full page - without an address naming one.
 *
 * Opening Polar starts a new chat, as Gemini in Chrome and ChatGPT do, unless
 * the person chose "Continue the last chat" in Polar's settings (as Sider
 * offers). Two cases are not an opening and keep the chat on screen whatever
 * the setting: the browser reloading the very view Polar was open in, and the
 * extension's per-tab panel moving between tabs while it stays open. Earlier
 * chats are never lost either way; they are in the history. Client-safe.
 */

export interface OpenChatInput {
    /** The "When Polar opens" setting is "Continue the last chat". */
    readonly continueLast: boolean;
    /** The page reloaded with Polar already open in it: the same view, back. */
    readonly cameBack: boolean;
    /** The extension's panel keeps one chat per tab while it stays open. */
    readonly perTab: boolean;
    /** The chat this tab (or this open panel) was last in; empty when it
     *  asked for a new one, which it keeps whatever the setting. */
    readonly tabThread: string | null;
    /** The chat last used anywhere in this browser. */
    readonly lastThread: string | null;
}

/** The chat to reopen, or null for a new one. */
export function chatOnOpen(input: OpenChatInput): string | null {
    const tab = input.tabThread;
    if (input.continueLast || input.cameBack) return tab !== null ? tab || null : input.lastThread || null;
    // Session storage starts empty with each opening of the extension's
    // panel, so this is only the tab's chat from this same opening.
    if (input.perTab) return tab || null;
    return null;
}
