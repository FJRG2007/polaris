/**
 * The house rules for a conversation.
 *
 * Three sets of them, because the three kinds of conversation are not the same
 * thing wearing different names. A space is a workplace: what is said in a
 * channel is a record other people rely on, and an operator may reasonably want
 * an edit to leave a trail. A direct message is two people talking, and the
 * expectation there is the one every messenger has taught - you can take back
 * what you said, and it goes.
 *
 * So every rule below is answered per scope rather than once for the instance,
 * and the same admin who wants edits pinned down in channels can leave direct
 * messages alone.
 *
 * The defaults are the permissive end on purpose: a message can be edited
 * whenever, deleting one leaves a line saying so, and the earlier versions are
 * readable. An operator tightens from there. What they cannot do is loosen past
 * the ceilings here, which are the limits of what the storage and the render
 * path were built for rather than a matter of taste.
 */

import { z } from "zod";
import { MAX_CHAT_MESSAGE } from "./chat.js";

/**
 * Which set of rules a conversation is under.
 *
 * The same three shapes `CHAT_CHANNEL_KINDS` names, grouped by where they live
 * rather than by what they are called: a channel is in a space, and a group and
 * a direct message are not.
 */
export const CHAT_RULE_SCOPES = ["space", "group", "dm"] as const;

export type ChatRuleScope = (typeof CHAT_RULE_SCOPES)[number];

export const CHAT_RULE_SCOPE_LABELS: Record<ChatRuleScope, string> = {
    space: "Spaces",
    group: "Group chats",
    dm: "Direct messages"
};

export const CHAT_RULE_SCOPE_NOTES: Record<ChatRuleScope, string> = {
    space: "Channels inside a space - the rooms a team works in, and the record they leave.",
    group: "Three or more people in one conversation, outside any space.",
    dm: "One person and one other."
};

/**
 * Which scope a conversation of this shape falls under.
 *
 * Pure and here rather than beside the database, because the composer needs the
 * same answer the server will reach: a field that let somebody type a message
 * the send would then refuse is a field that wastes the message.
 */
export function chatRuleScopeOf(channel: {
    spaceId: string | null;
    kind: string;
}): ChatRuleScope {
    if (channel.spaceId) return "space";
    return channel.kind === "group" ? "group" : "dm";
}

/** What a limit of zero means everywhere below: there is no limit. Stored as a
 *  number rather than a null so the form has one kind of value to hold. */
export const CHAT_NO_LIMIT = 0;

/**
 * The most a single file may be allowed to be, in MiB.
 *
 * Not a matter of taste: an attachment is read into memory whole on its way in
 * and on its way back out, so the ceiling is what one request may reasonably
 * cost the server. Something larger belongs in Drive with a link to it.
 */
export const CHAT_ATTACHMENT_CEILING_MIB = 100;

/** The most files one message may be allowed to carry. */
export const CHAT_ATTACHMENT_COUNT_CEILING = 25;

/** The longest an edit window may be set to. Past a week, "you may still edit
 *  it" and "you may always edit it" are the same sentence, and the second one is
 *  already spelled zero. */
export const CHAT_EDIT_WINDOW_CEILING_MINUTES = 60 * 24 * 7;

/** The most messages a minute an account may be allowed. High enough that a fast
 *  typist with something to say never meets it. */
export const CHAT_RATE_CEILING = 600;

/**
 * One scope's rules.
 *
 * Every number is coerced rather than required to arrive as a number: this is
 * read back out of a text column and typed into a form, and both of those hand
 * over strings.
 */
export const chatRulesSchema = z.object({
    /** The longest one message may be. The hard ceiling stays what the message
     *  body schema enforces; this only tightens it. */
    maxMessageLength: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_CHAT_MESSAGE)
        .default(MAX_CHAT_MESSAGE),
    /** How many messages one account may send a minute in one conversation, or
     *  zero for as many as they can type. */
    maxPerMinute: z.coerce.number().int().min(0).max(CHAT_RATE_CEILING).default(CHAT_NO_LIMIT),
    /** How many files ride on one message. Zero turns attachments off for this
     *  scope, which is a real answer for an instance that does not want files in
     *  private conversations at all. */
    maxAttachments: z.coerce.number().int().min(0).max(CHAT_ATTACHMENT_COUNT_CEILING).default(10),
    /** The biggest single file, in MiB. */
    maxAttachmentMib: z.coerce.number().int().min(1).max(CHAT_ATTACHMENT_CEILING_MIB).default(25),
    /** How long after sending a message may still be edited or deleted, or zero
     *  for always - which is the default, and what everybody expects. */
    editWindowMinutes: z.coerce
        .number()
        .int()
        .min(0)
        .max(CHAT_EDIT_WINDOW_CEILING_MINUTES)
        .default(CHAT_NO_LIMIT),
    /**
     * Whether a deleted message leaves a line saying it was deleted.
     *
     * On by default. A conversation where replies suddenly answer nothing reads
     * worse than one that admits something was taken back, and the tombstone is
     * what keeps a thread under a deleted message reachable. Off is the other
     * defensible answer - it is what Discord does - and it removes the row
     * outright, which is the point of choosing it.
     */
    deleteLeavesTrace: z.boolean().default(true),
    /**
     * Whether the versions before an edit are kept and readable.
     *
     * On by default: "(edited)" without a way to see what changed asks everybody
     * to take the edit on trust. Turned off, no earlier version is recorded from
     * then on - the setting decides what is written, not only what is shown, so
     * an operator who says no history is not left with one in the database.
     */
    keepEditHistory: z.boolean().default(true)
});

export type ChatRules = z.infer<typeof chatRulesSchema>;

/** What every scope starts on before an admin touches anything. */
export const DEFAULT_CHAT_RULES: ChatRules = chatRulesSchema.parse({});

/**
 * Rules out of whatever was stored, never a throw.
 *
 * An unset key, a truncated row, a field added in a later version: all of them
 * fall back to the default for that field rather than taking the app down. A
 * conversation refusing to open because a setting is malformed would be the
 * worst possible failure for a value that is only ever a limit.
 */
export function parseChatRules(stored: string | null | undefined): ChatRules {
    if (!stored) return DEFAULT_CHAT_RULES;
    try {
        const parsed = chatRulesSchema.safeParse(JSON.parse(stored));
        return parsed.success ? parsed.data : DEFAULT_CHAT_RULES;
    } catch {
        return DEFAULT_CHAT_RULES;
    }
}

/**
 * Whether a message sent then may still be changed now.
 *
 * Pure, and separate from the check that uses it, so the window can be reasoned
 * about without a database and a clock: this is the one rule where being wrong
 * means somebody is told they cannot edit something they can.
 */
export function withinEditWindow(rules: ChatRules, sentAt: Date, now: Date = new Date()): boolean {
    if (rules.editWindowMinutes === CHAT_NO_LIMIT) return true;
    return now.getTime() - sentAt.getTime() <= rules.editWindowMinutes * 60_000;
}

/** The window as a sentence, for the refusal and for the admin form. */
export function editWindowLabel(minutes: number): string {
    if (minutes === CHAT_NO_LIMIT) return "always";
    if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
    if (minutes < 60 * 24) {
        const hours = Math.round(minutes / 60);
        return hours === 1 ? "1 hour" : `${hours} hours`;
    }
    const days = Math.round(minutes / (60 * 24));
    return days === 1 ? "1 day" : `${days} days`;
}
