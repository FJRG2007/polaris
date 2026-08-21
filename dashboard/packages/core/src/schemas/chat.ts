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
 * `text` and `voice` live in a space and are named. `dm` is between exactly two
 * accounts and `group` between three or more; neither belongs to a space, and
 * neither is named by anybody - the name is who is in it.
 *
 * A voice channel is a room rather than a record: there is no message list in
 * one, and walking in is joining the call that is already there. It is the same
 * channel row and the same call machinery as a video call in a text channel -
 * what differs is that the call is the point rather than something started
 * inside a conversation.
 */
export const CHAT_CHANNEL_KINDS = ["text", "voice", "dm", "group"] as const;

/** The two kinds somebody can actually make. A direct message is opened by
 *  picking people, not by choosing a kind. */
export const CHAT_SPACE_CHANNEL_KINDS = ["text", "voice"] as const;

export type ChatSpaceChannelKind = (typeof CHAT_SPACE_CHANNEL_KINDS)[number];

export type ChatChannelKind = (typeof CHAT_CHANNEL_KINDS)[number];

/**
 * What wrote a message, and what kind of thing it is.
 *
 * `system` is Polaris itself saying somebody joined or a call started, and it
 * has no author. `poll` is a question with answers under it: the message still
 * carries the question as its body, so it is searched, quoted, forwarded and
 * previewed in the rail exactly like anything else somebody said - what makes it
 * a poll is the row hanging off it, not a different kind of message.
 */
export const CHAT_MESSAGE_KINDS = ["text", "system", "call", "poll"] as const;

export type ChatMessageKind = (typeof CHAT_MESSAGE_KINDS)[number];

/**
 * What somebody is doing in the box, for the line under the conversation.
 *
 * Typing is not the only thing worth saying out loud. A voice message is half a
 * minute of nothing from the other side, and without this the person waiting has
 * no way to tell it apart from having been left: the dots do not appear, because
 * nobody is typing. Every messenger with recordings in it says which one it is.
 */
export const CHAT_ACTIVITIES = ["typing", "recording"] as const;

export type ChatActivity = (typeof CHAT_ACTIVITIES)[number];

/**
 * Why somebody is reporting a message.
 *
 * A short list, because a long one is a list nobody reads to the end of and a
 * free-text box is a report nobody can sort. What does not fit is "something
 * else" plus the note, which is where the useful ones end up anyway.
 */
export const CHAT_REPORT_REASONS = [
    "spam",
    "abuse",
    "sexual",
    "violence",
    "illegal",
    "other"
] as const;

export type ChatReportReason = (typeof CHAT_REPORT_REASONS)[number];

/** What each one is called where somebody picks it. */
export const CHAT_REPORT_LABELS: Record<ChatReportReason, string> = {
    spam: "Spam or a scam",
    abuse: "Harassment or hate",
    sexual: "Sexual content",
    violence: "Violence or self-harm",
    illegal: "Something illegal",
    other: "Something else"
};

/** How a moderator settled it. There is no middle state: a queue with one is a
 *  queue with rows nobody owns. */
export const CHAT_REPORT_STATUSES = ["open", "kept", "removed"] as const;

export type ChatReportStatus = (typeof CHAT_REPORT_STATUSES)[number];

/** The longest a note may be. Room to explain, not room to paste a log. */
export const MAX_CHAT_REPORT_NOTE = 1000;

export const chatReportSchema = z.object({
    messageId: z.string().uuid(),
    reason: z.enum(CHAT_REPORT_REASONS),
    note: z.string().trim().max(MAX_CHAT_REPORT_NOTE).default("")
});

export type ChatReportInput = z.infer<typeof chatReportSchema>;

/** Typing when a tab does not say - one running a build from before recordings
 *  were announced still sends the bare call. */
export const chatActivitySchema = z.enum(CHAT_ACTIVITIES).catch("typing").default("typing");

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

/** How many messages one request may ask the ticks for. A conversation holds a
 *  window of a few pages on screen; this is comfortably past that. */
export const MAX_CHAT_RECEIPTS = 200;

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
    private: z.boolean().default(false),
    kind: z.enum(CHAT_SPACE_CHANNEL_KINDS).default("text"),
    /** The heading it sits under, or null for the ones above the first one. */
    categoryId: z.string().uuid().nullable().default(null)
});

export type ChatChannelCreateInput = z.infer<typeof chatChannelCreateSchema>;

/**
 * How long somebody waits between messages in one channel, in seconds.
 *
 * A ladder rather than a free number, because the useful settings are few and a
 * box accepting 4 is a box somebody will type 40000 into. Zero is off, which is
 * every channel until somebody decides otherwise.
 *
 * It is the per-room version of the instance's own rate limit: that one exists
 * to stop a script, this one exists to stop a hundred people shouting over each
 * other, and a room that needs the second usually needs it for an hour rather
 * than forever.
 */
export const CHAT_SLOWMODE_STEPS = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 3600, 21600] as const;

export type ChatSlowmode = (typeof CHAT_SLOWMODE_STEPS)[number];

/** The setting as a schema: one of the steps, and nothing else. */
export const chatSlowmodeSchema = z
    .number()
    .int()
    .refine(
        (value): value is ChatSlowmode =>
            (CHAT_SLOWMODE_STEPS as readonly number[]).includes(value),
        "That is not one of the waits offered"
    );

/**
 * How much longer somebody has to wait, in seconds.
 *
 * Zero means they may send. Kept as arithmetic rather than a query so the same
 * answer can be given in two places without asking the database twice: the
 * server refuses on it, and the composer counts down on it so the wait is
 * something somebody watches rather than something they are told about after
 * writing a paragraph.
 */
export function slowmodeWait(input: {
    /** The channel's setting, in seconds. */
    slowmode: number;
    /** When this person last said something here, or null if they have not. */
    lastSentAt: Date | null;
    now: Date;
}): number {
    if (input.slowmode <= 0 || !input.lastSentAt) return 0;
    const elapsed = (input.now.getTime() - input.lastSentAt.getTime()) / 1000;
    // Rounded up: half a second left is still a wait, and telling somebody zero
    // and then refusing them is the one answer worse than the truth.
    const left = Math.max(0, Math.ceil(input.slowmode - elapsed));
    // And never longer than the wait itself. Two machines mean two clocks, and a
    // message stamped in the future would otherwise hold somebody for the
    // difference between them - an hour of skew being an hour of silence in a
    // room set to thirty seconds.
    return Math.min(input.slowmode, left);
}

/**
 * A wait, written the way somebody would say it.
 *
 * Whole units only. "1 minute 43 seconds" is a stopwatch; what a person needs to
 * know is roughly how long they are being asked to hold on for, and every
 * messenger that shows this shows it coarsely.
 *
 * Always a number, never "an hour". This is a picker's option as well as a
 * sentence, and one option reading "an hour" between "30 minutes" and "2 hours"
 * is the odd one out - which is why every messenger writes the number here.
 */
export function slowmodeSpoken(seconds: number): string {
    if (seconds >= 3600) {
        const hours = Math.round(seconds / 3600);
        return `${hours} ${hours === 1 ? "hour" : "hours"}`;
    }
    if (seconds >= 60) {
        const minutes = Math.round(seconds / 60);
        return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
    }
    return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

export const chatChannelUpdateSchema = z.object({
    channelId: z.string().uuid(),
    name: channelName.optional(),
    topic: z.string().trim().max(MAX_CHAT_TOPIC).optional(),
    archived: z.boolean().optional(),
    /** Moving it under a different heading, or out from under all of them. */
    categoryId: z.string().uuid().nullable().optional(),
    slowmode: chatSlowmodeSchema.optional()
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
    userIds: z
        .array(z.string().uuid())
        .min(1, "Pick somebody")
        .max(MAX_GROUP_MEMBERS - 1),
    /** What to call a group, when whoever is starting it has something in mind.
     *  Ignored for a one-to-one conversation, which is named after the person in
     *  it. Empty is the ordinary case and leaves it named after its people. */
    name: z.string().trim().max(MAX_CHAT_CHANNEL_NAME).optional()
});

export type ChatDirectOpenInput = z.infer<typeof chatDirectOpenSchema>;

export const chatSendSchema = z.object({
    channelId: z.string().uuid(),
    body: chatMessageBody,
    /** The thread this belongs in. Takes the message out of the channel. */
    parentId: z.string().uuid().nullable().optional(),
    /** The message this one answers, shown quoted above it and left in the
     *  channel. The ordinary way to answer something; a thread is the
     *  alternative for when a side conversation would bury the room. */
    replyToId: z.string().uuid().nullable().optional()
});

export type ChatSendInput = z.infer<typeof chatSendSchema>;

/**
 * The soonest a message may be scheduled for.
 *
 * A minute, and it is a floor rather than a nicety: the sweep runs on a timer,
 * so anything asked for inside the next few seconds would go late by definition
 * and read as a broken feature. Somebody who wants it now has the button next
 * to the one they used to get here.
 */
export const SCHEDULE_SOONEST_MS = 60 * 1000;

/**
 * The furthest ahead one may be scheduled.
 *
 * A year. Not a technical limit - it is what stops a typo in a date field
 * parking somebody's message in the year 3000, where nothing will ever send it
 * and nothing will ever show it to them again.
 */
export const SCHEDULE_FURTHEST_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Writing something now and sending it later.
 *
 * The moment is an instant rather than a date and a time, because the two are
 * only a moment once a zone is applied and the zone is the writer's - see
 * `wallClock`. The window is checked here and again on the server, since a
 * moment in the past is a message that goes the second it is written and one in
 * the far future is a message that never goes at all.
 */
export const chatScheduleSchema = z.object({
    channelId: z.string().uuid(),
    // Empty is allowed, as it is for a live message: a message that is only a
    // file is a message.
    body: z.string().trim().max(MAX_CHAT_MESSAGE),
    parentId: z.string().uuid().nullable().optional(),
    replyToId: z.string().uuid().nullable().optional(),
    forwarded: z.boolean().default(false),
    sendAt: z.string().datetime()
});

export type ChatScheduleInput = z.infer<typeof chatScheduleSchema>;

/** Whether a moment is one a message may be scheduled for, and why not. Pure, so
 *  the dialog can say it before the server does. */
export function scheduleRefusal(sendAt: Date, now: Date = new Date()): string | null {
    const wait = sendAt.getTime() - now.getTime();
    if (!Number.isFinite(wait)) return "Pick a date and a time";
    if (wait < SCHEDULE_SOONEST_MS) return "Pick a time at least a minute from now";
    if (wait > SCHEDULE_FURTHEST_MS) return "Pick a time within the next year";
    return null;
}

/** Sending somebody else's message on to another conversation. */
export const chatForwardSchema = z.object({
    messageId: z.string().uuid(),
    /** Where it goes. Proved against the reader like any other write. */
    channelId: z.string().uuid(),
    /** A line of their own on top of it, which is what a forward usually is. */
    note: z.string().trim().max(MAX_CHAT_MESSAGE).default("")
});

export type ChatForwardInput = z.infer<typeof chatForwardSchema>;

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

/**
 * Polls: a question with answers under it, and who picked what.
 *
 * The question is the message's own body rather than a column of its own, which
 * is the whole reason a poll needs no special case anywhere else in Chat: it is
 * searched, quoted, forwarded, announced in a toast and shown in the rail like
 * any other line somebody wrote. What hangs off the message is the answers and
 * the votes.
 *
 * Two decisions are offered because they are the two people actually make. One
 * is whether more than one answer may be picked - a lunch order takes one, a
 * "which of these can you make" takes several. The other is whether the tallies
 * are visible while it runs: a poll that shows a running total is a poll where
 * the first four votes decide the rest, and a room asking something contentious
 * wants the count kept back until it closes.
 */

/** The fewest answers a poll can have. One answer is not a question. */
export const MIN_POLL_OPTIONS = 2;

/** The most. Past ten it is a form rather than a poll, and the bars are too thin
 *  to read. */
export const MAX_POLL_OPTIONS = 10;

export const MAX_POLL_QUESTION = 300;

/** Long enough for a sentence, short enough that every answer fits on one line
 *  beside its bar. */
export const MAX_POLL_OPTION = 100;

/** How long a poll stays open, in hours. */
export const POLL_DURATIONS = [1, 4, 8, 24, 72, 168, 336] as const;

/** A poll with no clock on it, which somebody closes by hand. */
export const POLL_NO_END = 0;

export const POLL_DURATION_LABELS: Readonly<Record<number, string>> = {
    1: "1 hour",
    4: "4 hours",
    8: "8 hours",
    24: "1 day",
    72: "3 days",
    168: "1 week",
    336: "2 weeks",
    [POLL_NO_END]: "Until I close it"
};

/** What a poll runs for unless somebody says otherwise. A day is long enough for
 *  everybody in a room to see it and short enough to still be about today. */
export const DEFAULT_POLL_HOURS = 24;

const pollHours: readonly number[] = [POLL_NO_END, ...POLL_DURATIONS];

/**
 * The answers as they are stored.
 *
 * The dialog ships a fixed set of boxes and most of them are empty, so dropping
 * blanks is the ordinary case rather than an error. Repeats go too: two answers
 * reading the same thing split the vote between them and leave a result nobody
 * can act on, and somebody who typed the same word twice meant it once.
 *
 * Nothing is truncated here. What is too long is refused rather than quietly
 * shortened - a check that cannot fail is not a check, and an answer cut off
 * mid-word is a worse outcome than being told to shorten it.
 */
export function normalizePollOptions(options: readonly string[]): string[] {
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const raw of options) {
        const text = raw.trim().replace(/\s+/g, " ");
        if (text.length === 0) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        kept.push(text);
    }
    return kept;
}

const pollOptions = z
    .array(z.string())
    .max(MAX_POLL_OPTIONS * 2)
    .transform(normalizePollOptions)
    .pipe(
        z
            .array(z.string().max(MAX_POLL_OPTION, "One of the answers is too long"))
            .min(MIN_POLL_OPTIONS, "A poll needs at least two answers")
            .max(MAX_POLL_OPTIONS, `A poll holds up to ${MAX_POLL_OPTIONS} answers`)
    );

export const chatPollCreateSchema = z.object({
    channelId: z.string().uuid(),
    question: z
        .string()
        .trim()
        .min(1, "Ask something first")
        .max(MAX_POLL_QUESTION, "That question is longer than a poll can carry"),
    options: pollOptions,
    /** Whether somebody may pick more than one answer. */
    multiple: z.boolean().default(false),
    /** Whether the tallies stay hidden until it closes. */
    hideResults: z.boolean().default(false),
    /** How long it stays open, in hours. Zero for one that only a person ends. */
    hours: z
        .number()
        .refine((value) => pollHours.includes(value), "That is not a length to offer")
        .default(DEFAULT_POLL_HOURS),
    /** A poll asked inside a thread, and one asked as an answer to something.
     *  The same two a message carries, because a poll is one. */
    parentId: z.string().uuid().nullable().optional(),
    replyToId: z.string().uuid().nullable().optional()
});

export type ChatPollCreateInput = z.infer<typeof chatPollCreateSchema>;

/**
 * Picking answers, as one decision rather than one press per answer.
 *
 * The whole selection travels each time, so a vote is idempotent and the server
 * never has to work out what changed: an empty list is somebody taking their
 * vote back, which every poll should allow while it is still running.
 */
export const chatPollVoteSchema = z.object({
    messageId: z.string().uuid(),
    optionIds: z.array(z.string().uuid()).max(MAX_POLL_OPTIONS)
});

export type ChatPollVoteInput = z.infer<typeof chatPollVoteSchema>;

/** When a poll of this length runs out, or null when it has no clock. */
export function pollClosesAt(hours: number, now = new Date()): Date | null {
    return hours === POLL_NO_END ? null : new Date(now.getTime() + hours * 60 * 60 * 1000);
}

/**
 * Whether a poll is over.
 *
 * Worked out on read rather than written by a job, on the same terms as a mute
 * that expires: nothing has to be running for a poll to close on time, and a
 * deployment whose sweep is wedged does not leave every poll in it open forever.
 */
export function pollIsClosed(
    poll: { closesAt: Date | string | null; closedAt: Date | string | null },
    now = new Date()
): boolean {
    if (poll.closedAt !== null) return true;
    return poll.closesAt !== null && new Date(poll.closesAt).getTime() <= now.getTime();
}

/**
 * Whether the tallies may be shown yet.
 *
 * A hidden poll shows nothing until it closes, with one thing that is not an
 * exception at all: your own vote is always yours to see, which is what stops
 * the card looking like it dropped the press.
 */
export function pollResultsVisible(
    poll: { hideResults: boolean; closesAt: Date | string | null; closedAt: Date | string | null },
    now = new Date()
): boolean {
    return !poll.hideResults || pollIsClosed(poll, now);
}

export const chatMarkReadSchema = z.object({
    channelId: z.string().uuid(),
    /** The newest message the reader has actually seen. */
    messageId: z.string().uuid()
});

export type ChatMarkReadInput = z.infer<typeof chatMarkReadSchema>;

/**
 * Putting a conversation back to unread.
 *
 * `messageId` is where the reader wants to pick it up again, and the mark lands
 * just before it. Absent from the conversation list, where there is no message
 * under the pointer and the answer is "the last thing somebody said to me" -
 * which the server works out, because only it knows which messages count.
 */
export const chatMarkUnreadSchema = z.object({
    channelId: z.string().uuid(),
    messageId: z.string().uuid().optional()
});

export type ChatMarkUnreadInput = z.infer<typeof chatMarkUnreadSchema>;

/** The ticks under messages a screen is already showing, asked for again after
 *  the other person caught up. Bounded by what a conversation holds on screen. */
export const chatReceiptsSchema = z.object({
    channelId: z.string().uuid(),
    messageIds: z.array(z.string().uuid()).max(MAX_CHAT_RECEIPTS)
});

export type ChatReceiptsInput = z.infer<typeof chatReceiptsSchema>;

export const chatMembersSchema = z.object({
    /** A space or a channel, depending on which action is being called. */
    id: z.string().uuid(),
    userIds: z.array(z.string().uuid()).min(1).max(MAX_GROUP_MEMBERS)
});

export type ChatMembersInput = z.infer<typeof chatMembersSchema>;

/**
 * Looking for something somebody said.
 *
 * Every field narrows and none of them widens: the reader's own reachable
 * conversations are the outer bound and are decided by the service, never by
 * anything in here. A filter that could reach further than the rail can would be
 * a way to read a room you are not in.
 *
 * A search with no term is a real search - "every file Ada put in this channel"
 * is a question - so the term is optional and the filters stand on their own.
 */
export const CHAT_SEARCH_ATTACHMENTS = ["any", "file", "image", "link"] as const;

export type ChatSearchAttachment = (typeof CHAT_SEARCH_ATTACHMENTS)[number];

/** One word each, because they are read under the word "Carrying" in a column
 *  the width of a sidebar - "With an image" said the same thing and pushed the
 *  row off the side of the panel. */
export const CHAT_SEARCH_ATTACHMENT_LABELS: Record<ChatSearchAttachment, string> = {
    any: "Anything",
    file: "Files",
    image: "Images",
    link: "Links"
};

/** How many hits one search comes back with. Past this the answer is a better
 *  filter, not a longer list nobody scrolls. */
export const CHAT_SEARCH_LIMIT = 50;

/** A calendar day, as a date field hands one over. */
const isoDay = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "That is not a date")
    .nullable()
    .default(null);

export const chatSearchSchema = z.object({
    term: z.string().trim().max(200).default(""),
    /** One conversation, or null for everywhere this reader can reach. */
    channelId: z.string().uuid().nullable().default(null),
    authorId: z.string().uuid().nullable().default(null),
    has: z.enum(CHAT_SEARCH_ATTACHMENTS).default("any"),
    /** Inclusive, and read as whole days in the reader's own reckoning: "after
     *  the 3rd" meaning "not including the 3rd" is nobody's understanding of it. */
    after: isoDay,
    before: isoDay
});

export type ChatSearchInput = z.infer<typeof chatSearchSchema>;

/** Whether a search would narrow anything at all. An empty one is a request for
 *  the whole archive, and the screen says so instead of fetching it. */
export function chatSearchIsEmpty(input: ChatSearchInput): boolean {
    return (
        input.term.length === 0 &&
        input.authorId === null &&
        input.has === "any" &&
        input.after === null &&
        input.before === null
    );
}

/**
 * The first web address in a message, or null.
 *
 * Only the first: a message with six links is a list, and six cards under it is
 * the message buried under its own footnotes.
 *
 * Code is taken out before looking. A fenced block full of shell is exactly
 * where an address appears that nobody meant as a link, and unfurling it would
 * both misread the message and send Polaris off to fetch something somebody was
 * only quoting.
 */
export function firstLink(body: string): string | null {
    const prose = body
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/~~~[\s\S]*?~~~/g, " ")
        .replace(/`[^`]*`/g, " ");

    const match = /https?:\/\/[^\s<>"')\]]+/i.exec(prose);
    if (!match) return null;

    // Trailing punctuation belongs to the sentence, not the address: "see
    // https://example.com." is a link and a full stop.
    const address = match[0].replace(/[.,;:!?]+$/, "");
    if (address.length > MAX_LINK_LENGTH) return null;
    return address;
}

/** The longest address Polaris will look at. Past this it is a payload rather
 *  than a link, and it also keeps the stored one inside what a unique index can
 *  hold. */
export const MAX_LINK_LENGTH = 512;

/**
 * What a group is called.
 *
 * Not `channelName`: that one is a slug, lowercased and collapsed to dashes so a
 * room somebody capitalized differently is the same room. A group's name is a
 * label a person wrote - "Weekend plans" is what they meant - and emptying it
 * puts the conversation back to being called after the people in it.
 */
export const chatGroupNameSchema = z.object({
    channelId: z.string().uuid(),
    name: z.string().trim().max(MAX_CHAT_CHANNEL_NAME)
});

export type ChatGroupNameInput = z.infer<typeof chatGroupNameSchema>;

/** A heading inside a space, with channels under it. */
export const MAX_CHAT_CATEGORY_NAME = 60;

export const chatCategoryCreateSchema = z.object({
    spaceId: z.string().uuid(),
    /** A label rather than a slug: it is a heading somebody wrote, and nothing
     *  is ever addressed by it. */
    name: z.string().trim().min(1, "Give the category a name").max(MAX_CHAT_CATEGORY_NAME)
});

export type ChatCategoryCreateInput = z.infer<typeof chatCategoryCreateSchema>;

export const chatCategoryUpdateSchema = z.object({
    categoryId: z.string().uuid(),
    name: z.string().trim().min(1).max(MAX_CHAT_CATEGORY_NAME)
});

export type ChatCategoryUpdateInput = z.infer<typeof chatCategoryUpdateSchema>;

/**
 * How long a conversation stays quiet.
 *
 * The set every messenger has settled on, and the last one is the one that
 * matters: a silence with no end is a different decision from a silence that
 * lapses, and offering only timed options makes somebody re-mute a noisy channel
 * every morning. Minutes rather than a date, so the choice means the same thing
 * whenever it is made and nothing has to be recomputed on the way to the server.
 */
export const MUTE_DURATIONS = [15, 60, 180, 480, 1440] as const;

/** Minutes, or 0 for "until I turn it back on". */
export const MUTE_FOREVER = 0;

export const MUTE_LABELS: Readonly<Record<number, string>> = {
    15: "For 15 minutes",
    60: "For 1 hour",
    180: "For 3 hours",
    480: "For 8 hours",
    1440: "For 24 hours",
    [MUTE_FOREVER]: "Until I turn it back on"
};

/** The lengths a mute may be, as one set: the offered durations and no end.
 *  Anything else is not a state any screen could describe afterwards. */
const MUTE_MINUTES: readonly number[] = [MUTE_FOREVER, ...MUTE_DURATIONS];

export const muteSchema = z.object({
    channelId: z.string().uuid(),
    /** Null means unmute. */
    minutes: z
        .number()
        .refine((value) => MUTE_MINUTES.includes(value), "That is not a length to mute for")
        .nullable()
});

export type MuteInput = z.infer<typeof muteSchema>;

/** When a mute of this length ends, or null when it does not. */
export function muteEndsAt(minutes: number, now = new Date()): Date | null {
    return minutes === MUTE_FOREVER ? null : new Date(now.getTime() + minutes * 60_000);
}

/**
 * Whether a stored mute is still in force.
 *
 * A row whose end has passed is not muted, whatever the flag says. Worked out
 * on read rather than cleared by a job, so nothing has to be running for a
 * silence to expire on time.
 */
export function muteInForce(
    row: { muted: boolean; mutedUntil: Date | string | null },
    now = new Date()
): boolean {
    if (!row.muted) return false;
    if (row.mutedUntil === null) return true;
    return new Date(row.mutedUntil).getTime() > now.getTime();
}

/**
 * Putting the channels of one space in the order somebody dragged them into.
 *
 * The whole list for a heading rather than one move: the client already knows
 * the order it just drew, and sending it means the server never has to work out
 * where "between these two" is. It also means two people rearranging at once end
 * with one of the two orders rather than with an interleaving neither chose.
 */
export const chatChannelReorderSchema = z.object({
    spaceId: z.string().uuid(),
    /** The heading these now sit under, or null for the ones above the first. */
    categoryId: z.string().uuid().nullable(),
    channelIds: z.array(z.string().uuid()).max(200)
});

export type ChatChannelReorderInput = z.infer<typeof chatChannelReorderSchema>;

export const chatCategoryReorderSchema = z.object({
    spaceId: z.string().uuid(),
    categoryIds: z.array(z.string().uuid()).max(100)
});

export type ChatCategoryReorderInput = z.infer<typeof chatCategoryReorderSchema>;

/** The gap left between neighbours, so a later insert has somewhere to go
 *  without every row being rewritten. */
export const CHAT_ORDER_STEP = 1024;

/**
 * How long an invitation lasts, in minutes, and what "no end" is.
 *
 * The set Discord settled on, because the question somebody is answering is
 * always one of "for this conversation", "for today", "for this week" or "for
 * good", and offering a free-form duration makes them do arithmetic to say it.
 */
export const INVITE_DURATIONS = [30, 60, 60 * 6, 60 * 12, 60 * 24, 60 * 24 * 7] as const;

/** Minutes, or 0 for an invite with no end. */
export const INVITE_FOREVER = 0;

export const INVITE_DURATION_LABELS: Readonly<Record<number, string>> = {
    30: "30 minutes",
    60: "1 hour",
    360: "6 hours",
    720: "12 hours",
    1440: "1 day",
    10080: "7 days",
    [INVITE_FOREVER]: "Never"
};

/** How many people one invitation may let in. */
export const INVITE_USE_LIMITS = [1, 5, 10, 25, 50, 100] as const;

/** Zero for an invite with no limit. */
export const INVITE_UNLIMITED = 0;

export const INVITE_USE_LABELS: Readonly<Record<number, string>> = {
    1: "1 use",
    5: "5 uses",
    10: "10 uses",
    25: "25 uses",
    50: "50 uses",
    100: "100 uses",
    [INVITE_UNLIMITED]: "No limit"
};

/** The code in a space invitation's URL. Long enough not to be guessed, short
 *  enough to read out over a call. Named for the space it belongs to, since
 *  account invitations have a length of their own. */
export const CHAT_INVITE_CODE_LENGTH = 10;

const inviteMinutes: readonly number[] = [INVITE_FOREVER, ...INVITE_DURATIONS];
const inviteUses: readonly number[] = [INVITE_UNLIMITED, ...INVITE_USE_LIMITS];

export const chatInviteCreateSchema = z.object({
    spaceId: z.string().uuid(),
    expiresMinutes: z
        .number()
        .refine((value) => inviteMinutes.includes(value), "That is not a length to offer"),
    maxUses: z
        .number()
        .refine((value) => inviteUses.includes(value), "That is not a limit to offer")
});

export type ChatInviteCreateInput = z.infer<typeof chatInviteCreateSchema>;

/** An invite code as it appears in a URL: the alphabet the generator uses and
 *  nothing else, so a malformed one is refused before it reaches the database. */
export const inviteCodeSchema = z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{6,32}$/, "That is not an invitation");

/** When an invitation of this length runs out, or null when it does not. */
export function inviteExpiresAt(minutes: number, now = new Date()): Date | null {
    return minutes === INVITE_FOREVER ? null : new Date(now.getTime() + minutes * 60_000);
}

/**
 * Whether an invitation may still be used.
 *
 * Every bound is checked here rather than at the place that made it, because the
 * code is the credential and the only moment that matters is the moment somebody
 * presents one.
 */
export function inviteUsable(
    invite: {
        expiresAt: Date | string | null;
        maxUses: number | null;
        uses: number;
        revokedAt: Date | string | null;
    },
    now = new Date()
): boolean {
    if (invite.revokedAt !== null) return false;
    if (invite.expiresAt !== null && new Date(invite.expiresAt).getTime() <= now.getTime()) {
        return false;
    }
    return invite.maxUses === null || invite.uses < invite.maxUses;
}
