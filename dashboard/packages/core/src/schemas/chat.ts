/**
 * Chat: what people say to each other inside Polaris.
 *
 * Distinct from Inbox, which is conversations arriving from outside on WhatsApp,
 * Telegram, Discord or Slack and answered by whoever is on support. This is the
 * inside: channels in a space, direct messages between accounts, threads under a
 * message. Nothing here reaches a platform, and nothing from a platform lands
 * here.
 *
 * The vocabularies are exported rather than inlined at the call sites for the
 * usual reason: a role or a kind that only exists as a string literal in four
 * places is four places to change and three to forget.
 */

import { z } from "zod";

/** Who a space is open to. The same two words a task space uses, and the same
 *  meanings - `internal` is everybody who can see the owner, which on an
 *  organization's space is that roster rather than the whole instance. */
export const CHAT_SPACE_VISIBILITIES = ["private", "internal"] as const;

export type ChatSpaceVisibility = (typeof CHAT_SPACE_VISIBILITIES)[number];

/** What somebody may do in a space. An admin adds channels and people; a member
 *  talks. There is no read-only role: a channel somebody may read and not write
 *  in is a decision about that channel, not about the space. */
export const CHAT_SPACE_ROLES = ["member", "admin"] as const;

export type ChatSpaceRole = (typeof CHAT_SPACE_ROLES)[number];

/**
 * What a conversation is.
 *
 * `text` lives in a space and is named. `dm` is between exactly two accounts and
 * `group` between three or more; neither belongs to a space, and neither is
 * named by anybody - the name is who is in it.
 */
export const CHAT_CHANNEL_KINDS = ["text", "dm", "group"] as const;

export type ChatChannelKind = (typeof CHAT_CHANNEL_KINDS)[number];

/** What wrote a message. `system` is Polaris itself saying somebody joined or a
 *  call started, and it has no author. */
export const CHAT_MESSAGE_KINDS = ["text", "system", "call"] as const;

export type ChatMessageKind = (typeof CHAT_MESSAGE_KINDS)[number];

export const MAX_CHAT_SPACE_NAME = 60;
export const MAX_CHAT_CHANNEL_NAME = 60;
export const MAX_CHAT_TOPIC = 200;

/** Long enough for anybody explaining something properly, short enough that a
 *  paste of a log file is refused rather than stored. Somebody with a log file to
 *  share has a snippet and an attachment. */
export const MAX_CHAT_MESSAGE = 8000;

/** How many people a group message holds. Past this it is a channel, and saying
 *  so is more useful than growing a list nobody can read the header of. */
export const MAX_GROUP_MEMBERS = 25;

/**
 * A channel name, as it is stored.
 *
 * Lowercased, spaces and runs of punctuation collapsed to single dashes, and
 * trimmed of leading and trailing ones. "Release  Planning!" and "release
 * planning" are the same channel, which is the point: a room somebody cannot
 * find because they capitalized it differently is a room that got created twice.
 *
 * Exported because the client normalizes with it too, so what somebody is shown
 * while typing is exactly what is about to be stored.
 */
export function normalizeChannelName(name: string): string {
    return name
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, MAX_CHAT_CHANNEL_NAME);
}

const channelName = z
    .string()
    .transform(normalizeChannelName)
    .pipe(z.string().min(1, "Give the channel a name").max(MAX_CHAT_CHANNEL_NAME));

const spaceName = z.string().trim().min(1, "Give the space a name").max(MAX_CHAT_SPACE_NAME);

/**
 * The text of a message.
 *
 * Trimmed, because trailing whitespace on a chat line is never meant and a
 * message of nothing but spaces is a message somebody sent by accident. Empty is
 * refused here rather than silently dropped - the composer knows not to send
 * one, and a request that asks anyway is asking for something that would look
 * like a bug to everybody in the channel.
 */
export const chatMessageBody = z
    .string()
    .trim()
    .min(1, "Write something first")
    .max(MAX_CHAT_MESSAGE, "That is longer than a message can be");

/**
 * One emoji.
 *
 * Stored as what was pressed, so nothing has to be kept in step to draw it back.
 * Capped by code points rather than characters because a single family emoji is
 * one glyph and eleven characters, and a limit that counted characters would
 * refuse it while allowing four separate ones.
 */
export const chatEmoji = z
    .string()
    .min(1)
    .refine((value) => [...value].length <= 8, "That is not a single emoji");

export const chatSpaceCreateSchema = z.object({
    name: spaceName,
    description: z.string().trim().max(MAX_CHAT_TOPIC).default(""),
    visibility: z.enum(CHAT_SPACE_VISIBILITIES).default("private"),
    /** The organization it belongs to, or null for one of somebody's own. */
    orgId: z.string().uuid().nullable().optional()
});

export type ChatSpaceCreateInput = z.infer<typeof chatSpaceCreateSchema>;

export const chatSpaceUpdateSchema = z.object({
    spaceId: z.string().uuid(),
    name: spaceName.optional(),
    description: z.string().trim().max(MAX_CHAT_TOPIC).optional(),
    visibility: z.enum(CHAT_SPACE_VISIBILITIES).optional(),
    archived: z.boolean().optional()
});

export type ChatSpaceUpdateInput = z.infer<typeof chatSpaceUpdateSchema>;

export const chatChannelCreateSchema = z.object({
    spaceId: z.string().uuid(),
    name: channelName,
    topic: z.string().trim().max(MAX_CHAT_TOPIC).default(""),
    /** A channel only the people put in it can see. */
    private: z.boolean().default(false)
});

export type ChatChannelCreateInput = z.infer<typeof chatChannelCreateSchema>;

export const chatChannelUpdateSchema = z.object({
    channelId: z.string().uuid(),
    name: channelName.optional(),
    topic: z.string().trim().max(MAX_CHAT_TOPIC).optional(),
    archived: z.boolean().optional()
});

export type ChatChannelUpdateInput = z.infer<typeof chatChannelUpdateSchema>;

/**
 * Opening a direct message.
 *
 * The caller is never in this list - they are the session - so one id is a
 * one-to-one conversation and more is a group. Duplicates are dropped by the
 * service rather than refused: asking twice for the same person is not an error,
 * it is a list somebody built by clicking.
 */
export const chatDirectOpenSchema = z.object({
    userIds: z.array(z.string().uuid()).min(1, "Pick somebody").max(MAX_GROUP_MEMBERS - 1)
});

export type ChatDirectOpenInput = z.infer<typeof chatDirectOpenSchema>;

export const chatSendSchema = z.object({
    channelId: z.string().uuid(),
    body: chatMessageBody,
    /** The message this is a reply to, which puts it in that thread. */
    parentId: z.string().uuid().nullable().optional()
});

export type ChatSendInput = z.infer<typeof chatSendSchema>;

export const chatEditSchema = z.object({
    messageId: z.string().uuid(),
    body: chatMessageBody
});

export type ChatEditInput = z.infer<typeof chatEditSchema>;

export const chatReactSchema = z.object({
    messageId: z.string().uuid(),
    emoji: chatEmoji
});

export type ChatReactInput = z.infer<typeof chatReactSchema>;

export const chatMarkReadSchema = z.object({
    channelId: z.string().uuid(),
    /** The newest message the reader has actually seen. */
    messageId: z.string().uuid()
});

export type ChatMarkReadInput = z.infer<typeof chatMarkReadSchema>;

export const chatMembersSchema = z.object({
    /** A space or a channel, depending on which action is being called. */
    id: z.string().uuid(),
    userIds: z.array(z.string().uuid()).min(1).max(MAX_GROUP_MEMBERS)
});

export type ChatMembersInput = z.infer<typeof chatMembersSchema>;
