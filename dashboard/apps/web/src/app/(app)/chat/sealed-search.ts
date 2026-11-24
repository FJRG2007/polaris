"use client";

/**
 * A chat search that also finds sealed text (docs/chat-e2ee-mls.md, Search).
 * The server matches the words of plain messages; the words of sealed ones are
 * matched on this device, by its index of what it opened, and the server is
 * asked only for those messages by id, under the same rules. With sealed chat
 * off, or no words to look for, it is the plain search.
 */

import * as core from "@polaris/core";
import type { ChatSearchHit } from "@/lib/chat/search";
import * as sealedChat from "@/lib/chat/e2ee/sealed-chat";
import { searchMessagesAction, searchSealedAction } from "./actions";
import { bodyMatches, SEARCH_CANDIDATES } from "@/lib/chat/e2ee/sealed-search-index";

/** Both answers as one list: each message once, newest first, at most `limit`. */
export function mergeHits(plain: readonly ChatSearchHit[], sealed: readonly ChatSearchHit[], limit: number = core.CHAT_SEARCH_LIMIT): readonly ChatSearchHit[] {
    if (!sealed.length) return plain;
    const seen = new Set<string>();
    const out: ChatSearchHit[] = [];
    for (const hit of [...plain, ...sealed]) {
        if (seen.has(hit.message.id)) continue;
        seen.add(hit.message.id);
        out.push(hit);
    }
    out.sort((a, b) => (a.message.createdAt === b.message.createdAt ? (a.message.id < b.message.id ? 1 : -1) : a.message.createdAt < b.message.createdAt ? 1 : -1));
    return out.slice(0, limit);
}

/** Search as the panel asks (`asked` is its filters, parsed again by the server). */
export async function searchChat(asked: Record<string, unknown>, proof: string | null): Promise<readonly ChatSearchHit[]> {
    const plain = searchMessagesAction(asked, proof);
    const parsed = core.chatSearchSchema.safeParse(asked);
    const query = parsed.success ? parsed.data : null;
    const term = query?.term ?? "";
    if (!query || !term || !sealedChat.sealedChatActive()) return (await plain).hits;
    const ids = await sealedChat.searchSealedText(term, query.channelId, SEARCH_CANDIDATES).catch((caught: unknown) => {
        console.warn("polaris: this device's sealed messages could not be searched:", caught);
        return [] as string[];
    });
    const [found, sealed] = await Promise.all([plain, ids.length ? searchSealedAction(query, ids, proof) : null]);
    if (sealed?.gone.length)
        void sealedChat.forgetSealedText(sealed.gone).catch((caught: unknown) => console.warn("polaris: gone messages stayed in this device's search index:", caught));
    return mergeHits(found.hits, sealed?.hits ?? []);
}

/**
 * A sealed hit found by its words that, opened as it is now, no longer holds
 * them (edited since, or no longer opening here): left out. One not opened yet
 * stays until it is.
 */
export function stillMatches(hit: ChatSearchHit, term: string): boolean {
    const { message } = hit;
    if (!message.sealed || !term.trim()) return true;
    const content = sealedChat.openedContent(message.id, message.sealedEditedAt);
    if (content === undefined) return true;
    return content !== null && bodyMatches(content.body, term);
}
