/**
 * Chat, as tools an agent can call.
 *
 * An assistant that can read what was said in a conversation and answer in it
 * is the difference between "summarise what I missed" working and not. Every
 * one of these goes through the chat's own layer - `lib/chat/chat-service` for
 * the list of conversations, `lib/chat/messages` for reading and sending - so
 * the account reaches exactly the conversations it is in, a block it set still
 * holds, and a message sent here is the same message, with the same
 * notifications and the same rules, as one typed in the composer.
 *
 * Deliberately not offered: editing or deleting a message, creating a channel,
 * adding or removing people, attachments and calls. Those are a person's
 * decisions about a room other people are in.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { moreLine, pageFields, pageOf } from "./paging";
import { McpRefusal, type McpCaller, type McpTool } from "../protocol";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import { defineMcpSearch, preferMatches } from "../search";

/**
 * The chat services, loaded when a tool runs rather than when the catalogue
 * does: listing the tools should not start the messaging stack.
 */
async function services() {
    const [chat, messages] = await Promise.all([
        import("@/lib/chat/chat-service"),
        import("@/lib/chat/messages")
    ]);
    return { chat, messages };
}

/** How much of one message a read carries. A message may be long; a page of
 *  them is what a model reads, and one wall of text should not crowd out the
 *  rest. */
const MESSAGE_LIMIT = 4_000;

function actorFor(caller: McpCaller): { id: string } {
    return { id: caller.userId };
}

/**
 * Run a chat operation, turning the chat's own refusal into one the model reads.
 *
 * `ChatAccessError` carries a sentence from the chat catalog - "you are not in
 * that conversation", "that is longer than a message can be" - and its
 * `message` is that sentence in the default language, which is the one a
 * model is addressed in here.
 */
async function attempt<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (caught) {
        const { ChatAccessError } = await import("@/lib/chat/access");
        if (caught instanceof ChatAccessError) throw new McpRefusal(caught.message);
        throw caught;
    }
}

const conversationId = z
    .string()
    .uuid()
    .describe("The conversation's id, as chat_conversations returned it.");

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const listInput = z.object({
    query: z
        .string()
        .trim()
        .max(120)
        .default("")
        .describe(
            "Words for the conversation's name, its topic, or the people in a direct message, in any language. The best matches come first; when nothing matches, every conversation is listed."
        ),
    unreadOnly: z.boolean().default(false).describe("Only conversations with something unread."),
    ...pageFields
});

/** Where a conversation search reads: its name (the people, for a direct
 *  message), then its topic, then what kind it is. */
const CONVERSATION_FIELDS: readonly core.SearchField<ChatChannelView>[] = [
    { text: (channel) => channel.name, weight: 1 },
    { text: (channel) => channel.topic, weight: 0.6 },
    { text: (channel) => channel.kind, weight: 0.5 }
];

const listConversationsTool: McpTool<z.infer<typeof listInput>> = {
    name: "chat_conversations",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List conversations",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "The chat channels, groups and direct messages this account is in or can open, with how much is unread in each. Start here to find a conversation's id.",
    input: listInput,
    category: "chat",
    scope: "chat.use",
    readOnly: true,
    async run(input, caller) {
        const { chat } = await services();
        const channels = await chat.listChannels(actorFor(caller));
        const found = core.matchForModel(
            channels.filter((channel) => !input.unreadOnly || channel.unread > 0),
            input.query,
            CONVERSATION_FIELDS,
            { one: "conversation", other: "conversations" }
        );
        const matched = found.items.map((channel) => ({
            id: channel.id,
            name: channel.name,
            kind: channel.kind,
            unread: channel.unread,
            lastMessageAt: channel.lastMessageAt,
            archived: channel.archived,
            spaceId: channel.spaceId
        }));
        const page = pageOf(matched, input.offset, input.limit);
        if (page.items.length === 0) {
            return {
                text: "No conversations matched.",
                structured: { conversations: [], nextOffset: null }
            };
        }
        return {
            text:
                (found.note ? `${found.note}\n` : "") +
                page.items
                    .map(
                        (row) =>
                            `${row.id}  ${row.name}  (${row.kind})${row.unread > 0 ? `  ${row.unread} unread` : ""}`
                    )
                    .join("\n") +
                moreLine(page),
            structured: {
                conversations: page.items,
                nextOffset: page.nextOffset,
                matched: found.matched
            }
        };
    }
};

const readInput = z.object({
    conversationId,
    before: z
        .string()
        .uuid()
        .optional()
        .describe(
            "Read the messages before this one. Send the olderThan of the previous call to go further back."
        ),
    limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(25)
        .describe("How many messages to return, newest last.")
});

const readMessagesTool: McpTool<z.infer<typeof readInput>> = {
    name: "chat_messages",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Read a conversation",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "The latest messages in one conversation, oldest first, with who wrote each. Thread replies are not included. Page backwards with before.",
    input: readInput,
    category: "chat",
    scope: "chat.use",
    readOnly: true,
    async run(input, caller) {
        const { messages } = await services();
        const page = await attempt(() =>
            messages.readChannel(actorFor(caller), input.conversationId, input.before)
        );
        // The service reads a screenful; the model gets the newest `limit` of
        // it, and the cursor moves to the oldest one it was actually given.
        const shown = page.messages.slice(-input.limit);
        const olderThan =
            shown.length < page.messages.length ? (shown[0]?.id ?? null) : page.olderThan;
        const rows = shown.map((message) => {
            const withheld = message.deleted || message.blocked;
            const body = withheld ? "" : message.body.slice(0, MESSAGE_LIMIT);
            return {
                id: message.id,
                author: message.authorName,
                at: message.createdAt,
                // i18n-ignore read by the calling model, not shown to a person
                body,
                truncated: !withheld && message.body.length > MESSAGE_LIMIT,
                deleted: message.deleted,
                fromBlocked: message.blocked,
                replies: message.replyCount,
                attachments: message.attachments.map((attachment) => attachment.name),
                mentionsYou: message.mentionsYou
            };
        });
        if (rows.length === 0) {
            return {
                text: "Nothing has been said here yet.",
                structured: { messages: [], olderThan: null }
            };
        }
        const lines = rows.map((row) => {
            const said = row.deleted
                ? "(deleted)"
                : row.fromBlocked
                  ? "(from somebody you blocked)"
                  : row.body;
            const files = row.attachments.length > 0 ? ` [${row.attachments.join(", ")}]` : "";
            return `[${row.at}] ${row.author ?? "someone"}: ${said}${files}`;
        });
        return {
            text: lines.join("\n") + (olderThan ? `\n(older messages: before=${olderThan})` : ""),
            structured: { messages: rows, olderThan }
        };
    }
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const sendInput = z.object({
    conversationId,
    body: core.chatMessageBody.describe("What to say, in Markdown. It is sent as this account."),
    replyToId: z
        .string()
        .uuid()
        .optional()
        .describe("A message in the same conversation this answers, shown quoted above it.")
});

const sendMessageTool: McpTool<z.infer<typeof sendInput>> = {
    name: "chat_send",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Send a message",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Send a message to a conversation this account is in, as this account. Everybody in it is notified as if it had been typed - confirm with the person before speaking for them.",
    input: sendInput,
    category: "chat",
    scope: "chat.use",
    readOnly: false,
    destructive: false,
    async run(input, caller) {
        const { messages } = await services();
        const id = await attempt(() =>
            messages.send(
                actorFor(caller),
                core.chatSendSchema.parse({
                    channelId: input.conversationId,
                    body: input.body,
                    replyToId: input.replyToId ?? null
                }),
                [],
                input.replyToId ? { messageId: input.replyToId, forwarded: false } : null
            )
        );
        return { text: "Sent.", structured: { id } };
    }
};

/** The conversations this account is in or can open, for `polaris_search`. */
export const CHAT_SEARCH = defineMcpSearch({
    id: "chat.conversations",
    app: "chat",
    category: "chat",
    scope: "chat.use",
    async search(query, caller, limit) {
        const { chat } = await services();
        const channels = await chat.listChannels(actorFor(caller));
        return preferMatches(channels, query, CONVERSATION_FIELDS, limit).map((channel) => ({
            id: channel.id,
            name: channel.name,
            kind: "conversation",
            keywords: [channel.topic, channel.kind],
            next: [
                { tool: "chat_messages", args: { conversationId: channel.id } },
                { tool: "chat_send", args: { conversationId: channel.id } }
            ]
        }));
    }
});

export const CHAT_TOOLS = [
    listConversationsTool,
    readMessagesTool,
    sendMessageTool
] as unknown as McpTool<never>[];
