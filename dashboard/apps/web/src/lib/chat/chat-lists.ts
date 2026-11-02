import * as chat from "@/lib/chat/chat-service";
import { listBlocked } from "@/lib/blocks";
import { friendIds } from "@/lib/friends-service";

export type ChatLists = Awaited<ReturnType<typeof chatLists>>;

/**
 * Everything the rail holds, read together.
 *
 * Each part fails on its own: one that could not be read comes back null and the
 * screen keeps what it had, rather than losing the others over it.
 */
export async function chatLists(me: { id: string; name: string }) {
    const part = <T>(read: Promise<T>): Promise<T | null> =>
        read.catch((caught: unknown) => {
            console.error("[chat] a part of the conversation list could not be read", caught);
            return null;
        });
    const [channels, spaces, categories, blocked, friends] = await Promise.all([
        part(chat.listChannels(me)),
        part(chat.listSpaces(me)),
        part(chat.listCategories(me)),
        part(listBlocked(me.id).then((people) => people.map((person) => person.id))),
        // Ids only, from one indexed read: what decides whether a person's menu
        // offers "Remove friend".
        part(friendIds(me.id).then((ids) => [...ids]))
    ]);
    return { channels, spaces, categories, blocked, friends };
}
