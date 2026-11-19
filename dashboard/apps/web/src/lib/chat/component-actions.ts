/**
 * What a button or a form under a message does when it is pressed - see
 * `message-components`.
 *
 * The press names a message and a position, and a form's answers. Everything
 * else is read from the stored message: which action, for whom, which fields.
 * The presser must still be in the conversation, must be the one the component
 * is for when it names one, and the action checks its own app's rules again.
 *
 * Server-only.
 */

import { chatWordsFor } from "./text";
import { prisma } from "@polaris/db";
import { seesMessage } from "./ephemeral";
import { rateLimit } from "@/lib/rate-limit-service";
import { channelAccess, ChatAccessError } from "./access";
import { postAgentMessage, updateAgentMessage } from "./agent-message";
import {
    formAnswersSchema,
    readComponents,
    selectValuesSchema,
    type MessageComponentInput
} from "./message-components";

/** Presses one person makes a minute: each can be a model turn or a write. */
const PRESSES_PER_MINUTE = 20;

export interface ComponentPress {
    readonly messageId: string;
    readonly index: number;
    /** A form's answers; ignored for anything else. */
    readonly fields?: Readonly<Record<string, string>>;
    /** A select's picked values; ignored for anything else. */
    readonly values?: readonly string[];
}

/** UPDATE_MESSAGE: what to change on the message the press came from. */
export interface MessagePatch {
    readonly body?: string;
    readonly components?: readonly MessageComponentInput[];
}

/** A follow-up answer to the press: a new message, ephemeral to the presser when asked. */
export interface FollowUp {
    readonly body: string;
    readonly components?: readonly MessageComponentInput[];
    /** Only the one who pressed sees it (Discord's flag 64). */
    readonly ephemeral?: boolean;
}

/**
 * One press, as an action sees it - the interaction, in Discord's words. An
 * action answers through `update` (Discord's UPDATE_MESSAGE: the message the
 * press came from, changed in place, for everybody who sees it) and
 * `followUp` (a new message, ephemeral to the presser when asked). Neither
 * has to come before the action returns: a slow action can answer later, as a
 * deferred interaction does.
 */
export interface Pressed {
    readonly user: { readonly id: string; readonly isAdmin: boolean };
    readonly message: {
        readonly id: string;
        readonly channelId: string;
        readonly replyToId: string | null;
        readonly parentId: string | null;
        readonly agent: string | null;
        readonly authorLabel: string | null;
    };
    readonly value: string | null;
    readonly values: readonly string[];
    readonly fields: Readonly<Record<string, string>>;
    readonly update: (patch: MessagePatch) => Promise<void>;
    readonly followUp: (answer: FollowUp) => Promise<string>;
}

export type Action = (pressed: Pressed) => Promise<void>;

const ACTIONS: Record<string, Action> = {
    "polar.retry": retryPolar,
    "tasks.create": createTask
};

/**
 * Adds an app's action under `<app>.<name>`. It runs only from a component on
 * a message that app wrote, so it answers (and edits) only its own messages.
 */
export function registerComponentAction(name: string, action: Action): void {
    ACTIONS[name] = action;
}

/** The app an action belongs to: `tasks` for `tasks.create`. */
function ownerOf(action: string): string {
    return action.slice(0, action.indexOf("."));
}

/** Run one press. Throws a `ChatAccessError` with the sentence for the presser. */
export async function pressComponent(
    user: { readonly id: string; readonly isAdmin: boolean },
    press: ComponentPress
): Promise<void> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: press.messageId },
        select: {
            id: true,
            channelId: true,
            replyToId: true,
            parentId: true,
            agent: true,
            authorLabel: true,
            components: true,
            deletedAt: true,
            expiresAt: true,
            audience: true
        }
    });
    // The presser must still see the message: in the conversation, not past
    // its timer, and in its audience when it is ephemeral.
    if (
        !message ||
        message.deletedAt ||
        (message.expiresAt && message.expiresAt.getTime() <= Date.now()) ||
        !seesMessage(message.audience, user.id) ||
        !(await channelAccess({ id: user.id }, message.channelId))
    ) {
        throw new ChatAccessError({ key: "errors.componentGone" });
    }
    const component = readComponents(message.components)[press.index];
    if (!component || component.type === "link" || component.disabled) {
        throw new ChatAccessError({ key: "errors.componentGone" });
    }
    if (component.for && component.for !== user.id) throw new ChatAccessError({ key: "errors.componentNotYours" });
    const action = ACTIONS[component.action];
    // An action answers only on its own app's messages: what `tasks.create`
    // edits is a message Tasks wrote, never Polar's or a person's.
    if (!action || ownerOf(component.action) !== message.agent) {
        throw new ChatAccessError({ key: "errors.componentGone" });
    }
    if (!(await rateLimit(`chat-component:${user.id}`, PRESSES_PER_MINUTE, 60_000)).ok) {
        throw new ChatAccessError({ key: "errors.componentTooFast" });
    }
    let fields: Record<string, string> = {};
    if (component.type === "form") {
        const parsed = formAnswersSchema(component.fields).safeParse(press.fields ?? {});
        if (!parsed.success) throw new ChatAccessError({ key: "errors.componentInvalid" });
        fields = parsed.data as Record<string, string>;
    }
    let values: string[] = [];
    if (component.type === "select") {
        const parsed = selectValuesSchema(component).safeParse(press.values ?? []);
        if (!parsed.success) throw new ChatAccessError({ key: "errors.componentInvalid" });
        values = parsed.data;
    }
    const agent = ownerOf(component.action);
    await action({
        user,
        message,
        value: component.type === "button" ? (component.value ?? null) : null,
        values,
        fields,
        update: async (patch) => {
            const changed = await updateAgentMessage({
                messageId: message.id,
                channelId: message.channelId,
                agent,
                ...patch
            });
            if (!changed) throw new ChatAccessError({ key: "errors.componentGone" });
        },
        followUp: (answer) =>
            postAgentMessage({
                channelId: message.channelId,
                parentId: message.parentId,
                replyToId: message.id,
                agent,
                label: message.authorLabel ?? agent,
                body: answer.body,
                ...(answer.components ? { components: answer.components } : {}),
                ...(answer.ephemeral ? { audience: [user.id] } : {})
            })
    });
}

/** "Try again" under a Polar reply that was not an answer: asked again, written over it. */
async function retryPolar({ user, message }: Pressed): Promise<void> {
    const asked = message.replyToId
        ? await prisma.chatMessage.findUnique({
              where: { id: message.replyToId },
              select: { id: true, channelId: true, authorId: true, parentId: true, body: true, deletedAt: true }
          })
        : null;
    if (!asked || asked.deletedAt || asked.channelId !== message.channelId) {
        throw new ChatAccessError({ key: "errors.componentGone" });
    }
    // The answer spends the asker's access and limits, so only they ask again.
    if (asked.authorId !== user.id) throw new ChatAccessError({ key: "errors.componentNotYours" });
    const { answerPolarMention } = await import("./polar-mention");
    await answerPolarMention(
        {
            channelId: asked.channelId,
            messageId: asked.id,
            authorId: user.id,
            parentId: asked.parentId,
            body: asked.body
        },
        message.id
    );
}

/**
 * `/task`'s form sent: the task made through the Tasks tool, with every check
 * the Tasks screen makes, and the form replaced by what it made so it cannot
 * be sent twice.
 */
async function createTask({ user, message, fields, update }: Pressed): Promise<void> {
    // Claimed first: two presses at once make one task, not two.
    const claimed = await prisma.chatMessage.updateMany({
        where: { id: message.id, editedAt: null },
        data: { editedAt: new Date() }
    });
    if (claimed.count === 0) throw new ChatAccessError({ key: "errors.componentGone" });
    const release = () =>
        prisma.chatMessage.update({ where: { id: message.id }, data: { editedAt: null } }).catch(() => undefined);

    const { callSessionTool, sessionCaller } = await import("@/lib/mcp/session-call");
    const caller = await sessionCaller(user, ["tasks.read", "tasks.manage"]);
    const answer = await callSessionTool(
        caller,
        "tasks_create",
        { list: fields.list, name: fields.name, description: fields.description ?? "" },
        "chat"
    );
    const made = answer.ok
        ? (answer.structured as { id?: unknown; reference?: unknown } | null)
        : null;
    if (!made || typeof made.id !== "string") {
        await release();
        throw new ChatAccessError({
            key: answer.ok || answer.reason !== "throttled" ? "errors.taskNotCreated" : "errors.componentTooFast"
        });
    }
    const words = await chatWordsFor(user.id);
    const reference = typeof made.reference === "string" ? made.reference : "";
    await update({
        body: words("appCommands.task.created", { reference, name: fields.name ?? "" }),
        components: [{ type: "link", label: words("appCommands.task.openTask"), href: `/tasks/t/${made.id}` }]
    });
}
