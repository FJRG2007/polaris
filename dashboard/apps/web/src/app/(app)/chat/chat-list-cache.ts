/**
 * The chat rail as it last looked in this tab, so a reload draws it at once.
 *
 * Per tab and per account: the names in it are nobody else's to read on a shared
 * computer, and it goes with the tab.
 */

const PREFIX = "polaris.chat.lists.v1.";

export interface CachedChatLists<Channel, Space, Category> {
    readonly channels: readonly Channel[];
    readonly spaces: readonly Space[];
    readonly categories: readonly Category[];
}

/** What this tab kept for this account, or null when there is nothing usable. */
export function readChatLists<Channel, Space, Category>(
    viewerId: string
): CachedChatLists<Channel, Space, Category> | null {
    try {
        const parsed = JSON.parse(sessionStorage.getItem(PREFIX + viewerId) ?? "null") as {
            channels?: unknown;
            spaces?: unknown;
            categories?: unknown;
        } | null;
        if (!parsed) return null;
        const { channels, spaces, categories } = parsed;
        if (!Array.isArray(channels) || !Array.isArray(spaces) || !Array.isArray(categories)) {
            return null;
        }
        return {
            channels: channels as Channel[],
            spaces: spaces as Space[],
            categories: categories as Category[]
        };
    } catch {
        return null;
    }
}

/** Keep the lists for the next load. Storage that refuses costs only the head start. */
export function writeChatLists(viewerId: string, lists: CachedChatLists<unknown, unknown, unknown>): void {
    try {
        sessionStorage.setItem(PREFIX + viewerId, JSON.stringify(lists));
    } catch {
        // Full or blocked: the next load waits for the server, as it always did.
    }
}
