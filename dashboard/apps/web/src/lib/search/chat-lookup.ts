/**
 * The Chat quick switcher: people, conversations, channels and messages.
 *
 * Nothing here decides who may see what. People are the ones a conversation can
 * be started with (`searchForConversation`), conversations and channels are the
 * reader's own rail (`listChannels`), and messages are `searchMessages` - each of
 * them already bounded to what this reader reaches, so a conversation somebody
 * was removed from yesterday is gone from here on the same day as from the rail.
 *
 * Conversations and channels are matched on the rail rather than in the
 * database, because a direct message has no name of its own: its name is who is
 * in it, which only the rail resolves. The rail is the reader's own memberships -
 * tens of rows - and the palette asks once per pause and keeps the answer.
 */

import * as core from "@polaris/core";
import { searchMessages } from "@/lib/chat/search";
import { searchForConversation } from "@/lib/chat/access";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { listChannels, listSpaces, type ChatChannelView } from "@/lib/chat/chat-service";

/** What one match looks like; the palette's own row shape. */
export interface ChatHit {
    readonly id: string;
    readonly scope: core.ChatSearchScope;
    readonly label: string;
    readonly detail: string;
    readonly href: string;
    readonly image?: string | null;
}

/** Rows for one kind on its own, and for each kind when all four are asked. */
const ONE_KIND = 12;
const EACH_KIND = 5;

/** Where a person match opens: the conversation with them, made if needed. */
export function directHref(userId: string): string {
    return `/chat/with/${encodeURIComponent(userId)}`;
}

export async function chatLookup(
    actor: { id: string },
    scope: core.ChatSearchScope,
    query: string
): Promise<ChatHit[]> {
    const term = query.trim();
    // Read once however many kinds ask for it.
    let held: Promise<ChatChannelView[]> | null = null;
    const rail = () => (held ??= listChannels(actor));

    if (scope === "contacts") return people(actor, term, ONE_KIND);
    if (scope === "messages") return messages(actor, term, ONE_KIND);
    if (scope === "chats") return conversations(rail, term, ONE_KIND);
    if (scope === "channels") return channels(actor, rail, term, ONE_KIND);

    // All four. With nothing typed only the recent conversations are worth
    // listing: every person and every message is not an answer to anything.
    if (!term) return conversations(rail, term, ONE_KIND);
    const [found, chats, rooms, said] = await Promise.all([
        people(actor, term, EACH_KIND),
        conversations(rail, term, EACH_KIND),
        channels(actor, rail, term, EACH_KIND),
        messages(actor, term, EACH_KIND)
    ]);
    return [...found, ...chats, ...rooms, ...said];
}

async function people(actor: { id: string }, term: string, limit: number): Promise<ChatHit[]> {
    const { people: found } = await searchForConversation(actor, term, limit);
    return found.map((person) => ({
        id: person.id,
        scope: "contacts",
        label: person.name,
        detail: "Message",
        href: directHref(person.id)
    }));
}

function matches(channel: ChatChannelView, needle: string): boolean {
    if (!needle) return true;
    return [channel.name, ...channel.others.map((other) => other.name)].some((text) =>
        text.toLowerCase().includes(needle)
    );
}

/** Newest first, the way somebody remembers which conversation they mean. */
function byRecent(left: ChatChannelView, right: ChatChannelView): number {
    return (right.lastMessageAt ?? "").localeCompare(left.lastMessageAt ?? "");
}

type Rail = () => Promise<ChatChannelView[]>;

async function conversations(rail: Rail, term: string, limit: number): Promise<ChatHit[]> {
    const needle = term.toLowerCase();
    return (await rail())
        .filter((channel) => (channel.kind === "dm" || channel.kind === "group") && matches(channel, needle))
        .sort(byRecent)
        .slice(0, limit)
        .map((channel) => ({
            id: channel.id,
            scope: "chats",
            label: channel.name || channel.others.map((other) => other.name).join(", ") || "Direct message",
            detail: channel.kind === "group" ? "Group" : "Direct message",
            href: `/chat/c/${channel.id}`
        }));
}

async function channels(
    actor: { id: string },
    rail: Rail,
    term: string,
    limit: number
): Promise<ChatHit[]> {
    // Every channel in every space is not an answer to an empty box.
    if (!term) return [];
    const needle = term.toLowerCase();
    const [listed, spaces] = await Promise.all([rail(), listSpaces(actor)]);
    const spaceNames = new Map(spaces.map((space) => [space.id, space.name]));
    return listed
        .filter((channel) => channel.spaceId !== null && channel.name.toLowerCase().includes(needle))
        .slice(0, limit)
        .map((channel) => ({
            id: channel.id,
            scope: "channels",
            label: channel.name,
            detail: [channel.kind === "voice" ? "Voice" : null, spaceNames.get(channel.spaceId!) ?? null]
                .filter(Boolean)
                .join(" - "),
            href: `/chat/c/${channel.id}`
        }));
}

async function messages(actor: { id: string }, term: string, limit: number): Promise<ChatHit[]> {
    if (!term) return [];
    const hits = await searchMessages(actor, core.chatSearchSchema.parse({ term }));
    return hits.slice(0, limit).map((hit) => ({
        id: hit.message.id,
        scope: "messages",
        label: plainExcerpt(hit.message.body, 120) || "Attachment",
        detail: [hit.message.authorName, hit.channelName].filter(Boolean).join(" in "),
        href: `/chat/c/${hit.channelId}/${hit.message.id}`
    }));
}
