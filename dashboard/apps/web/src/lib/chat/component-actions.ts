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
import { publishChatChange } from "./live";
import { prisma, Prisma } from "@polaris/db";
import { rateLimit } from "@/lib/rate-limit-service";
import { channelAccess, ChatAccessError } from "./access";
import { formAnswersSchema, readComponents, storedComponents } from "./message-components";

/** Presses one person makes a minute: each can be a model turn or a write. */
const PRESSES_PER_MINUTE = 20;

export interface ComponentPress {
    readonly messageId: string;
    readonly index: number;
    /** A form's answers; ignored for a button. */
    readonly fields?: Readonly<Record<string, string>>;
}

interface Pressed {
    readonly user: { readonly id: string; readonly isAdmin: boolean };
    readonly message: { readonly id: string; readonly channelId: string; readonly replyToId: string | null };
    readonly value: string | null;
    readonly fields: Readonly<Record<string, string>>;
}

type Action = (pressed: Pressed) => Promise<void>;

const ACTIONS: Record<string, Action> = {
    "polar.retry": retryPolar,
    "tasks.create": createTask
};

/** Run one press. Throws a `ChatAccessError` with the sentence for the presser. */
export async function pressComponent(
    user: { readonly id: string; readonly isAdmin: boolean },
    press: ComponentPress
): Promise<void> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: press.messageId },
        select: { id: true, channelId: true, replyToId: true, components: true, deletedAt: true }
    });
    if (!message || message.deletedAt || !(await channelAccess({ id: user.id }, message.channelId))) {
        throw new ChatAccessError({ key: "errors.componentGone" });
    }
    const component = readComponents(message.components)[press.index];
    if (!component || component.type === "link") throw new ChatAccessError({ key: "errors.componentGone" });
    if (component.for && component.for !== user.id) throw new ChatAccessError({ key: "errors.componentNotYours" });
    const action = ACTIONS[component.action];
    if (!action) throw new ChatAccessError({ key: "errors.componentGone" });
    if (!(await rateLimit(`chat-component:${user.id}`, PRESSES_PER_MINUTE, 60_000)).ok) {
        throw new ChatAccessError({ key: "errors.componentTooFast" });
    }
    let fields: Record<string, string> = {};
    if (component.type === "form") {
        const parsed = formAnswersSchema(component.fields).safeParse(press.fields ?? {});
        if (!parsed.success) throw new ChatAccessError({ key: "errors.componentInvalid" });
        fields = parsed.data as Record<string, string>;
    }
    await action({
        user,
        message,
        value: component.type === "button" ? (component.value ?? null) : null,
        fields
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
async function createTask({ user, message, fields }: Pressed): Promise<void> {
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
    const components = storedComponents([
        { type: "link", label: words("appCommands.task.openTask"), href: `/tasks/t/${made.id}` }
    ]);
    await prisma.chatMessage.update({
        where: { id: message.id },
        data: {
            body: words("appCommands.task.created", { reference, name: fields.name ?? "" }),
            components: components as unknown as Prisma.InputJsonValue
        }
    });
    publishChatChange({ channelId: message.channelId, kind: "posted", actorId: "", messageIds: [message.id] });
}
