/**
 * Polar's tools after an `@polar` mention in Chat, and the approval a change
 * waits on there.
 *
 * Polar answers a mention with every tool the person who asked may use, as
 * them: the same set the Polar panel offers (`lib/polar/tools.ts`), through
 * the same MCP server and its checks. What differs is the room. Everybody in
 * the conversation reads the answer, and anybody in it may have written the
 * lines Polar reads, so:
 *
 * - A tool that only reads runs at once, as the asker - what it finds is what
 *   they asked to have posted.
 * - A tool that changes anything never runs in the turn. The call is kept
 *   (`PolarChatCall`), Polar's message says what it will do, and it runs only
 *   when the asker presses Approve under it. A standing "stop asking" grant
 *   from the panel does not apply here: it was given in a private chat, not in
 *   a room where somebody else's message can steer the model.
 * - Tools over secrets (Vault, passwords, keys, snippets) are never offered.
 *
 * After an approval the same mention is answered again with what was done, so
 * Polar can say so - or ask for the next change of a chain, which waits the
 * same way. Server-only.
 */

import { prisma } from "@polaris/db";
import { tool, type ToolSet } from "ai";
import { ChatAccessError } from "./access";
import type { Pressed } from "./component-actions";
import type { MessageComponentInput } from "./message-components";

/** Most steps one mention takes: discovery, a few reads, then the answer. */
export const MENTION_STEPS = 6;
/** How long a change waits for its approval. */
export const CALL_TTL_MS = 24 * 60 * 60 * 1000;
/** Characters of one tool answer Polar reads back after an approval. */
const RESULT_CHARS = 4_000;
/** Fields of a change shown under Polar's message, and characters of each. */
const SHOWN_FIELDS = 8;
const FIELD_CHARS = 200;

/** Tools never offered in a shared room, by name or area. */
const NEVER_OFFERED = /vault|password|secret|api[_ ]?key|snippet|credential|token/i;

/** One change Polar asked to make, held until it is approved. */
export interface PendingCall {
    readonly tool: string;
    readonly title: string;
    readonly input: unknown;
}

/** A change already approved and run, read back on the next answer. */
export interface DoneCall {
    readonly tool: string;
    readonly title: string;
    readonly ok: boolean;
    readonly text: string;
}

/** The tools one mention is answered with. */
export interface MentionToolkit {
    readonly tools: ToolSet;
    /** The names sent on the first step: discovery. */
    readonly first: string[];
    /** The names sent once discovery has found some. */
    readonly activeFor: (found: ReadonlySet<string>) => string[];
    /** The change the turn stopped on, once one was asked for. */
    readonly pending: () => PendingCall | null;
}

/** What a change's tool tells the model while it waits. */
const WAITING =
    "Not run yet: it is shown in the conversation and runs when the person who asked approves it. Stop calling tools and say in one short sentence what you are about to do.";
const ONE_AT_A_TIME = "Not run: only one change is offered at a time. Mention it in your answer; it can be asked for after this one.";

/** Whether a tool may be offered in a shared room. */
export function offeredInRoom(entry: { readonly name: string; readonly category: string }): boolean {
    return !NEVER_OFFERED.test(entry.name) && !NEVER_OFFERED.test(entry.category);
}

/**
 * The asker's tools for one mention, or null when they have none - an account
 * that cannot act any more, or no tool to offer. Never throws: Polar still
 * answers in words without them.
 */
export async function mentionToolkit(userId: string): Promise<MentionToolkit | null> {
    try {
        const [{ actingUser }, { polarTools }, relevance] = await Promise.all([
            import("@/lib/mcp/acting-user"),
            import("@/lib/polar/tools"),
            import("@/lib/polar/tool-relevance")
        ]);
        const user = await actingUser(userId);
        if (!user) return null;
        const set = await polarTools(user);
        const catalog = set.catalog.filter(offeredInRoom);
        if (catalog.length === 0) return null;
        let pending: PendingCall | null = null;
        const tools: ToolSet = { ...relevance.findToolsTool(catalog) };
        for (const entry of catalog) {
            const real = set.tools[entry.name];
            const described = set.described[entry.name];
            if (!real || !described) continue;
            if (!described.writes) {
                tools[entry.name] = real;
                continue;
            }
            tools[entry.name] = tool({
                description: real.description,
                inputSchema: real.inputSchema,
                async execute(input: unknown) {
                    if (pending) return { ok: false, text: ONE_AT_A_TIME };
                    pending = { tool: entry.name, title: described.title, input };
                    return { ok: false, text: WAITING };
                }
            });
        }
        const always = [relevance.FIND_TOOLS];
        return {
            tools,
            first: relevance.activeToolNames(catalog, always),
            activeFor: (found) => relevance.activeToolNames(catalog, always, found),
            pending: () => pending
        };
    } catch (error) {
        console.error("chat: Polar's tools could not be built for a mention:", error);
        return null;
    }
}

/** The change as it is shown under Polar's message: its title and its fields. */
export function describeCall(call: PendingCall, line: (title: string) => string): string {
    const fields =
        call.input && typeof call.input === "object" && !Array.isArray(call.input)
            ? Object.entries(call.input as Record<string, unknown>)
            : [];
    const shown = fields
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .slice(0, SHOWN_FIELDS)
        .map(([name, value]) => {
            const text = typeof value === "string" ? value : JSON.stringify(value);
            const flat = text.replace(/\s+/g, " ").trim();
            const cut = flat.length > FIELD_CHARS ? `${flat.slice(0, FIELD_CHARS - 1)}...` : flat;
            return `- ${name}: ${cut.replaceAll("`", "'")}`;
        });
    return [line(call.title), ...shown].join("\n");
}

/** The buttons under a change: Approve and Cancel, only for the asker. */
export function callComponents(
    callId: string,
    askerId: string,
    words: (key: "polar.approve" | "polar.cancel") => string
): MessageComponentInput[] {
    return [
        { type: "button", label: words("polar.approve"), style: "success", action: "polar.approve", value: callId, for: askerId },
        { type: "button", label: words("polar.cancel"), style: "secondary", action: "polar.cancel", value: callId, for: askerId }
    ];
}

/** Keeps a change until it is approved, on the message that offers it. */
export async function holdCall(input: {
    readonly id: string;
    readonly ownerId: string;
    readonly messageId: string;
    readonly mentionId: string;
    readonly call: PendingCall;
    readonly done: readonly DoneCall[];
}): Promise<void> {
    await prisma.polarChatCall.create({
        data: {
            id: input.id,
            ownerId: input.ownerId,
            messageId: input.messageId,
            mentionId: input.mentionId,
            tool: input.call.tool,
            input: (input.call.input ?? {}) as object,
            done: input.done as unknown as object
        }
    });
    // Ones left waiting are dropped as new ones arrive: no sweep to schedule.
    await prisma.polarChatCall
        .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - CALL_TTL_MS) } } })
        .catch(() => undefined);
}

/**
 * Takes the change a button names off the shelf, once: the press must come
 * from its own message and from the person it waits on, within its day. Two
 * presses at once take it once.
 */
async function takeCall(pressed: Pressed) {
    const id = pressed.value ?? "";
    const row = await prisma.polarChatCall.findUnique({ where: { id } }).catch(() => null);
    if (!row || row.messageId !== pressed.message.id) throw new ChatAccessError({ key: "errors.componentGone" });
    if (row.ownerId !== pressed.user.id) throw new ChatAccessError({ key: "errors.componentNotYours" });
    const claimed = await prisma.polarChatCall.deleteMany({ where: { id } });
    if (claimed.count === 0 || row.createdAt.getTime() < Date.now() - CALL_TTL_MS) {
        throw new ChatAccessError({ key: "errors.componentGone" });
    }
    return row;
}

/** The earlier approved changes a row carries. Read total: a bad row is none. */
function doneOf(value: unknown): DoneCall[] {
    if (!Array.isArray(value)) return [];
    return value.filter(
        (item): item is DoneCall =>
            !!item &&
            typeof item === "object" &&
            typeof (item as DoneCall).tool === "string" &&
            typeof (item as DoneCall).text === "string"
    );
}

/** Approve: the change runs as the asker, and Polar answers again with what it did. */
export async function approveCall(pressed: Pressed): Promise<void> {
    const row = await takeCall(pressed);
    const mention = await prisma.chatMessage.findUnique({
        where: { id: row.mentionId },
        select: { id: true, channelId: true, authorId: true, parentId: true, body: true, deletedAt: true }
    });
    if (!mention || mention.deletedAt || mention.channelId !== pressed.message.channelId) {
        throw new ChatAccessError({ key: "errors.componentGone" });
    }
    const [{ actingUser }, { polarTools }] = await Promise.all([
        import("@/lib/mcp/acting-user"),
        import("@/lib/polar/tools")
    ]);
    const user = await actingUser(pressed.user.id);
    if (!user) throw new ChatAccessError({ key: "errors.componentGone" });
    // Built again now: a permission removed since the offer holds.
    const set = await polarTools(user);
    const run = set.tools[row.tool]?.execute;
    const title = set.described[row.tool]?.title ?? row.tool;
    let done: DoneCall;
    if (!run || !offeredInRoom({ name: row.tool, category: set.described[row.tool]?.category ?? "" })) {
        done = { tool: row.tool, title, ok: false, text: `You no longer have access to ${row.tool}.` };
    } else {
        try {
            const outcome = (await run(row.input, { toolCallId: row.id, messages: [] } as never)) as {
                ok?: unknown;
                text?: unknown;
            };
            const text = typeof outcome?.text === "string" ? outcome.text : "";
            done = { tool: row.tool, title, ok: outcome?.ok === true, text: text.slice(0, RESULT_CHARS) };
        } catch (error) {
            console.error(`chat: Polar's approved ${row.tool} failed:`, error);
            done = { tool: row.tool, title, ok: false, text: `${row.tool} failed.` };
        }
    }
    const { answerPolarMention } = await import("./polar-mention");
    await answerPolarMention(
        {
            channelId: mention.channelId,
            messageId: mention.id,
            authorId: pressed.user.id,
            parentId: mention.parentId,
            body: mention.body
        },
        pressed.message.id,
        [...doneOf(row.done), done]
    );
}

/** Cancel: nothing runs, and the message says so. */
export async function cancelCall(pressed: Pressed): Promise<void> {
    await takeCall(pressed);
    const { chatWordsFor } = await import("./text");
    const words = await chatWordsFor(pressed.user.id);
    await pressed.update({ body: words("polar.callCancelled"), components: [] });
}
