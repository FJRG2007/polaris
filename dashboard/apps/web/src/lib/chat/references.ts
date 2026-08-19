/**
 * A link to this Polaris, resolved for whoever is reading it.
 *
 * Pasting a conversation or a message into a conversation used to produce the
 * card Polaris draws for any other website - it fetched its own page and
 * described itself back to the reader, which said nothing anybody wanted to
 * know. What a person pasting a voice room wants shown is the room: what it is
 * called, who is in it, and a way in.
 *
 * Two decisions run through this module.
 *
 * **It is resolved when the message is read, never when it was sent.** Who is
 * sitting in a voice room is true for about a minute; a name stamped into the
 * message at send time would be a lie by the time anybody scrolled to it. So
 * nothing is stored on the message beyond the address, and this runs per read -
 * which is also what makes a renamed channel read correctly in a message from
 * March.
 *
 * **Reach is the reader's, not the sender's.** The person who pasted it could
 * obviously see it; the person reading may not be in that space at all. So
 * everything here is answered against the reader, and an out-of-reach reference
 * comes back carrying nothing at all - not the name, not the excerpt, not who
 * is in it. Saying "you cannot see #payroll" names #payroll, and a conversation
 * somebody is not in is exactly the thing Chat refuses to leak.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { reachableChannelIds, type ChatActor } from "./access";
import { extractReferences } from "@/components/rich-text/markdown";
import { appBaseUrl } from "@/lib/domain-service";
import { scopeTaskWhere, visibleScope } from "@/lib/tasks/access";

/** How much of a quoted message the card carries. A line: a card that repeats a
 *  paragraph is the paragraph twice, once in a box. */
const EXCERPT = 140;

/** The kinds resolved here: the ones whose meaning is a fact about the reader.
 *  A document and a note keep the label they were written with, which is the
 *  honest answer until somebody gives those two a reach check of their own. */
export type ResolvedKind = "channel" | "message" | "task";

/** A reference to something in Polaris, as the reader may have it. */
export interface ChatReferenceView {
    readonly kind: ResolvedKind;
    /** The address as written, so the renderer can match it to the chip it is
     *  drawing without re-parsing anything. */
    readonly id: string;
    /**
     * Whether this reader may see what it points at.
     *
     * False covers three cases on purpose - not in the conversation, the
     * conversation is gone, the message is gone - because telling them apart
     * would tell somebody outside a room whether a room exists.
     */
    readonly reachable: boolean;
    /** What the conversation is called. Empty when it is out of reach. */
    readonly name: string;
    /** text | voice | dm | group. Empty when out of reach. Decides whether the
     *  reference is drawn as a name in the sentence or as a card with a way in. */
    readonly channelKind: string;
    /** Where a message reference lives, so the card can link to it. Empty for a
     *  conversation, which is its own address. */
    readonly channelId: string;
    /** Who wrote the message, and what it said. Both empty for a conversation. */
    readonly authorName: string;
    readonly excerpt: string;
    /** When it was said. Empty for a conversation. */
    readonly at: string;
}

/** Out of reach, in the one shape every unreachable reference takes: the address
 *  and nothing else. Written once so no caller can invent a fuller one. */
function unavailable(kind: ResolvedKind, id: string): ChatReferenceView {
    return {
        kind,
        id,
        reachable: false,
        name: "",
        channelKind: "",
        channelId: "",
        authorName: "",
        excerpt: "",
        at: ""
    };
}

/** How long the deployment's own address is taken as still true. It changes when
 *  somebody sets a domain, which is not something that happens between two page
 *  loads of a conversation. */
const ORIGIN_TTL_MS = 5 * 60_000;

let remembered: { at: number; url: string | null } | null = null;

/**
 * The address this deployment answers on, cheaply.
 *
 * Needed only to recognise a full `https://` address written into a body -
 * anything composed here was folded to a `polaris:` address when it was pasted.
 * Worth caching hard, because working it out reads settings and can reach for
 * DNS, and this sits on the path that draws every page of every conversation.
 *
 * @param wanted - False when nothing being read contains an absolute address at
 *   all, which is nearly every page. Then this costs nothing at all.
 */
export async function polarisOrigin(wanted: boolean): Promise<string | null> {
    if (!wanted) return null;
    if (remembered && Date.now() - remembered.at < ORIGIN_TTL_MS) return remembered.url;
    const url = await appBaseUrl().catch(() => null);
    remembered = { at: Date.now(), url };
    return url;
}

/** Forget it, for a test that is a different deployment every case. Nothing in
 *  the app calls this. */
export function forgetOrigin(): void {
    remembered = null;
}

/** Whether any of these bodies could be carrying a full address at all. */
export function anyAbsolute(bodies: readonly string[]): boolean {
    return bodies.some((body) => body.includes("http://") || body.includes("https://"));
}

/**
 * The Chat references one body carries, as `kind/id` keys.
 *
 * Cheap first: the overwhelming majority of messages point at nothing, and this
 * runs on every one of them on every page. Parsing the Markdown is what makes an
 * address inside a code fence not a reference, so it cannot be skipped for the
 * ones that might - but it can be skipped for the ones that plainly do not.
 */
export function chatReferencesIn(body: string, origin: string | null = null): string[] {
    if (!body.includes("polaris:") && !body.includes("/chat/c/") && !body.includes("/tasks/t/")) {
        return [];
    }
    return extractReferences(body, origin)
        .filter((found) => RESOLVED.has(found.kind))
        .map((found) => `${found.kind}/${found.id}`);
}

const RESOLVED = new Set<string>(["channel", "message", "task"]);

/**
 * Resolve these references for this reader.
 *
 * One pass for a whole page of messages rather than one per message: the
 * conversations named across fifty messages are a handful, and the reach check
 * behind them is the same set the rail already builds.
 *
 * @returns what was found, by `kind/id`. An address that resolves to nothing is
 *   still in the map, marked out of reach: the renderer has to draw something,
 *   and a missing entry would leave the raw link on screen.
 */
export async function resolveChatReferences(
    actor: ChatActor,
    keys: readonly string[]
): Promise<Map<string, ChatReferenceView>> {
    const wanted = new Map<string, ResolvedKind>();
    for (const key of keys) {
        if (key.startsWith("channel/")) wanted.set(key, "channel");
        else if (key.startsWith("message/")) wanted.set(key, "message");
        else if (key.startsWith("task/")) wanted.set(key, "task");
    }
    if (wanted.size === 0) return new Map();

    const channelIds = [...wanted]
        .filter(([, kind]) => kind === "channel")
        .map(([key]) => key.slice("channel/".length));
    const messageIds = [...wanted]
        .filter(([, kind]) => kind === "message")
        .map(([key]) => key.slice("message/".length));
    const taskIds = [...wanted]
        .filter(([, kind]) => kind === "task")
        .map(([key]) => key.slice("task/".length));

    // The messages first, because the conversations they live in have to be
    // proved reachable too and may not be named anywhere else in the page.
    const messages = messageIds.length
        ? await prisma.chatMessage.findMany({
              where: { id: { in: messageIds } },
              select: {
                  id: true,
                  body: true,
                  kind: true,
                  authorId: true,
                  channelId: true,
                  deletedAt: true,
                  createdAt: true
              }
          })
        : [];

    const reachable = await reachableChannelIds(actor);
    const named = [...new Set([...channelIds, ...messages.map((row) => row.channelId)])].filter(
        (id) => reachable.has(id)
    );

    const [channels, authors, tasks] = await Promise.all([
        named.length
            ? prisma.chatChannel.findMany({
                  where: { id: { in: named } },
                  select: {
                      id: true,
                      name: true,
                      kind: true,
                      members: { select: { userId: true, user: { select: { name: true } } } }
                  }
              })
            : Promise.resolve([]),
        (async () => {
            const ids = [
                ...new Set(
                    messages.map((row) => row.authorId).filter((id): id is string => id !== null)
                )
            ];
            return ids.length
                ? prisma.user.findMany({
                      where: { id: { in: ids } },
                      select: { id: true, name: true }
                  })
                : [];
        })(),
        // The tasks this reader may actually open. Asked as one query narrowed
        // by their own scope rather than one check per task: anything the scope
        // does not return is out of reach, which is the same answer arrived at
        // without a second implementation of who may see what.
        (async () => {
            if (taskIds.length === 0) return [];
            const scope = await visibleScope({ id: actor.id, isAdmin: false });
            return prisma.task.findMany({
                where: { AND: [{ id: { in: taskIds } }, scopeTaskWhere(scope)] },
                select: { id: true, name: true }
            });
        })()
    ]);

    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    const authorNames = new Map(authors.map((author) => [author.id, author.name]));
    const resolved = new Map<string, ChatReferenceView>();

    for (const id of channelIds) {
        const channel = byId.get(id);
        if (!channel) {
            resolved.set(`channel/${id}`, unavailable("channel", id));
            continue;
        }
        resolved.set(`channel/${id}`, {
            kind: "channel",
            id,
            reachable: true,
            // A direct message and a group have no name of their own - they are
            // called after who is in them, the same way the rail draws them.
            name: channel.name || nameOfRoom(channel.members, actor.id),
            channelKind: channel.kind,
            channelId: id,
            authorName: "",
            excerpt: "",
            at: ""
        });
    }

    for (const id of messageIds) {
        const message = messages.find((row) => row.id === id);
        // A deleted message resolves to nothing on purpose: the tombstone is
        // part of the conversation it is in, and a card quoting one somewhere
        // else would be a quote of something that was taken back.
        if (!message || message.deletedAt || !reachable.has(message.channelId)) {
            resolved.set(`message/${id}`, unavailable("message", id));
            continue;
        }
        const channel = byId.get(message.channelId);
        resolved.set(`message/${id}`, {
            kind: "message",
            id,
            reachable: true,
            name: channel ? channel.name || nameOfRoom(channel.members, actor.id) : "",
            channelKind: channel?.kind ?? "",
            channelId: message.channelId,
            authorName: message.authorId ? (authorNames.get(message.authorId) ?? "") : "",
            excerpt: message.kind === "system" ? "" : plainExcerpt(message.body, EXCERPT),
            at: message.createdAt.toISOString()
        });
    }

    for (const id of taskIds) {
        const task = tasks.find((row) => row.id === id);
        if (!task) {
            resolved.set(`task/${id}`, unavailable("task", id));
            continue;
        }
        resolved.set(`task/${id}`, {
            kind: "task",
            id,
            reachable: true,
            name: task.name,
            channelKind: "",
            channelId: "",
            authorName: "",
            excerpt: "",
            at: ""
        });
    }

    return resolved;
}

/** What a room with no name of its own is called: the people in it, minus the
 *  reader. The same answer the conversation list gives, so a reference reads as
 *  the row it points at. */
function nameOfRoom(
    members: readonly { userId: string; user: { name: string } }[],
    readerId: string
): string {
    const others = members
        .filter((member) => member.userId !== readerId)
        .map((member) => member.user.name);
    return others.length > 0 ? others.join(", ") : "Just you";
}
