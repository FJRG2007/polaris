"use client";

/**
 * Sealed messages in the launcher's Chat lookup (docs/chat-e2ee-mls.md,
 * Search). The server's lookup (`chat-lookup.ts`) matches only the words it
 * holds, and it holds none for a sealed message, so these are matched on this
 * device by its index of what it opened, and the server is asked only for
 * those messages by id, under the rules the lookup itself answers to (no
 * unlock proof: what is locked or hidden stays out). The line shown is the
 * words this device opened; a hit whose kept words are not its current
 * version is left out rather than shown with words it may no longer have.
 *
 * With sealed chat off, nothing typed, or a scope that lists no messages, it
 * is nothing.
 */

import type { SearchHit } from "./lookup-service";
import * as sealedChat from "@/lib/chat/e2ee/sealed-chat";
import { searchSealedAction } from "@/app/(app)/chat/actions";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { SEARCH_CANDIDATES } from "@/lib/chat/e2ee/sealed-search-index";

/** Messages one scope lists: the same counts as `chat-lookup.ts`. */
const LIMITS: ReadonlyMap<string, number> = new Map([["messages", 12], ["chat", 5]]);

type Words = (key: "search.hits.attachment" | "search.hits.saidIn", values?: { author: string; channel: string }) => string;

/** This device's sealed messages that hold `term`, as the launcher's rows. */
export async function sealedLookupHits(scope: string, term: string, words: Words): Promise<SearchHit[]> {
    const limit = LIMITS.get(scope);
    const typed = term.trim();
    if (!limit || !typed || !sealedChat.sealedChatActive()) return [];
    const found = await sealedChat.searchSealedEntries(typed, null, SEARCH_CANDIDATES).catch((caught: unknown) => {
        console.warn("polaris: this device's sealed messages could not be searched:", caught);
        return [];
    });
    if (!found.length) return [];
    const answer = await searchSealedAction({ term: typed }, found.map((entry) => entry.id), null);
    if (answer.gone.length)
        void sealedChat.forgetSealedText(answer.gone).catch((caught: unknown) => console.warn("polaris: gone messages stayed in this device's search index:", caught));
    const kept = new Map(found.map((entry) => [entry.id, entry]));
    const hits: SearchHit[] = [];
    for (const hit of answer.hits) {
        const entry = kept.get(hit.message.id);
        if (!entry || (entry.editedAt ?? "") !== (hit.message.sealedEditedAt ?? "")) continue;
        const { authorName } = hit.message;
        hits.push({
            id: hit.message.id,
            scope: "messages",
            label: plainExcerpt(entry.body, 120) || words("search.hits.attachment"),
            detail: authorName && hit.channelName ? words("search.hits.saidIn", { author: authorName, channel: hit.channelName }) : authorName || hit.channelName || "",
            href: `/chat/c/${hit.channelId}/${hit.message.id}`
        });
        if (hits.length >= limit) break;
    }
    return hits;
}

/**
 * The server's rows with the sealed ones beside its messages: each message
 * once, and no more messages than the scope lists.
 */
export function withSealedHits(scope: string, found: readonly SearchHit[], sealed: readonly SearchHit[]): SearchHit[] {
    const limit = LIMITS.get(scope);
    if (!limit || !sealed.length) return [...found];
    const seen = new Set(found.map((hit) => hit.id));
    const room = Math.max(0, limit - found.filter((hit) => hit.scope === "messages").length);
    return [...found, ...sealed.filter((hit) => !seen.has(hit.id)).slice(0, room)];
}
