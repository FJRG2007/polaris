/**
 * Slash commands Polaris's own apps answer in any conversation, the way a
 * Discord app's commands work in every server it is in.
 *
 * - `/polar <question>`: Polar answers, exactly as `@polar` would.
 * - `/task <title>`: Tasks answers with a form - title, list, description -
 *   that only the one who asked can fill in, and creates the task from it.
 *
 * A command is offered only to somebody who can use its app, and checked again
 * when it runs. The message that runs it stays in the conversation, as a
 * linked game server's `/online` does: the others see what was asked.
 *
 * Server-only.
 */

import { can } from "@polaris/auth";
import { prisma } from "@polaris/db";
import { chatWordsFor } from "./text";
import { appCommandIn } from "./chat-command";
import { channelAccess } from "./access";
import { postAgentMessage } from "./agent-message";
import { rateLimit } from "@/lib/rate-limit-service";
import { MOST_CHOICES, type MessageComponentInput } from "./message-components";

/** A command as the composer lists it. */
export interface AppCommandView {
    readonly name: string;
    readonly description: string;
    /** What it takes after the name, as a word: "question". Null for none. */
    readonly hint: string | null;
    /** The app that answers it, by name. */
    readonly app: string;
}

/** How many commands one person runs a minute. Each one is a model turn or a write. */
const COMMANDS_PER_MINUTE = 10;

async function mayRun(userId: string, name: string): Promise<boolean> {
    if (name === "polar") {
        const { polarAccessFor } = await import("@/lib/polar/access");
        return (await polarAccessFor(userId)).use;
    }
    if (name === "task") return can(userId, "tasks.manage");
    return false;
}

/** The commands this person may run, in their language. Never throws: a list is not worth the composer. */
export async function appCommandsFor(userId: string): Promise<AppCommandView[]> {
    try {
        const words = await chatWordsFor(userId);
        const [polar, task] = await Promise.all([mayRun(userId, "polar"), mayRun(userId, "task")]);
        return [
            ...(polar
                ? [
                      {
                          name: "polar",
                          description: words("appCommands.polar.description"),
                          hint: words("appCommands.polar.hint"),
                          app: "Polar"
                      }
                  ]
                : []),
            ...(task
                ? [
                      {
                          name: "task",
                          description: words("appCommands.task.description"),
                          hint: words("appCommands.task.hint"),
                          app: words("appCommands.task.app")
                      }
                  ]
                : [])
        ];
    } catch (error) {
        console.error("chat: the app commands could not be listed:", error);
        return [];
    }
}

/**
 * Run the command a message that was just sent is. Never throws and never
 * fails the send: the message is in the conversation either way.
 */
export async function runAppCommand(messageId: string, actorId: string): Promise<void> {
    try {
        const message = await prisma.chatMessage.findUnique({
            where: { id: messageId },
            select: { body: true, channelId: true, parentId: true, kind: true, deletedAt: true, authorId: true }
        });
        if (!message || message.deletedAt || message.kind !== "text" || message.authorId !== actorId) return;
        const command = appCommandIn(message.body);
        if (!command) return;
        if (!(await channelAccess({ id: actorId }, message.channelId))) return;
        if (!(await mayRun(actorId, command.name))) return;
        if (!(await rateLimit(`chat-app-command:${actorId}`, COMMANDS_PER_MINUTE, 60_000)).ok) return;

        if (command.name === "polar") {
            const { answerPolarMention, claimPolarAnswer } = await import("./polar-mention");
            if (!claimPolarAnswer(messageId)) return;
            await answerPolarMention({
                channelId: message.channelId,
                messageId,
                authorId: actorId,
                parentId: message.parentId,
                body: message.body
            });
            return;
        }
        await offerTaskForm({ channelId: message.channelId, parentId: message.parentId, messageId }, actorId, command.text);
    } catch (error) {
        console.error("chat: an app command could not be run:", error);
    }
}

/** The lists this person can reach, as form choices: `Space / List`. */
export async function taskListChoices(user: {
    readonly id: string;
    readonly isAdmin: boolean;
}): Promise<{ value: string; label: string }[]> {
    const { callSessionTool, sessionCaller } = await import("@/lib/mcp/session-call");
    const caller = await sessionCaller(user, ["tasks.read"]);
    const answer = await callSessionTool(caller, "tasks_spaces", {}, "chat");
    if (!answer.ok) return [];
    const spaces = (answer.structured as { spaces?: unknown } | null)?.spaces;
    if (!Array.isArray(spaces)) return [];
    const choices: { value: string; label: string }[] = [];
    for (const space of spaces as { name?: unknown; lists?: unknown }[]) {
        if (!Array.isArray(space.lists) || typeof space.name !== "string") continue;
        for (const list of space.lists as { id?: unknown; name?: unknown }[]) {
            if (typeof list.id !== "string" || typeof list.name !== "string") continue;
            choices.push({ value: list.id, label: `${space.name} / ${list.name}`.slice(0, 80) });
        }
    }
    return choices.slice(0, MOST_CHOICES);
}

/** Tasks' answer to `/task`: the form, for the one who asked. */
async function offerTaskForm(
    where: { readonly channelId: string; readonly parentId: string | null; readonly messageId: string },
    actorId: string,
    title: string
): Promise<void> {
    const words = await chatWordsFor(actorId);
    const user = await prisma.user.findUnique({ where: { id: actorId }, select: { isAdmin: true } });
    const lists = await taskListChoices({ id: actorId, isAdmin: user?.isAdmin ?? false });
    const components: MessageComponentInput[] = lists.length
        ? [
              {
                  type: "form",
                  label: words("appCommands.task.form"),
                  action: "tasks.create",
                  title: words("appCommands.task.form"),
                  submit: words("appCommands.task.create"),
                  for: actorId,
                  fields: [
                      {
                          name: "name",
                          label: words("appCommands.task.name"),
                          kind: "text",
                          required: true,
                          max: 200,
                          ...(title ? { value: title.slice(0, 200) } : {})
                      },
                      {
                          name: "list",
                          label: words("appCommands.task.list"),
                          kind: "choice",
                          required: true,
                          options: lists,
                          value: lists[0]!.value
                      },
                      { name: "description", label: words("appCommands.task.details"), kind: "long", max: 4000 }
                  ]
              }
          ]
        : [{ type: "link", label: words("appCommands.task.openTasks"), href: "/tasks" }];
    await postAgentMessage({
        channelId: where.channelId,
        parentId: where.parentId,
        replyToId: where.messageId,
        agent: "tasks",
        label: words("appCommands.task.app"),
        body: lists.length ? words("appCommands.task.prompt") : words("appCommands.task.noLists"),
        components,
        // With no list to put a task in, the answer is only the asker's
        // business: "Only you can see this", as a Discord command answers.
        ...(lists.length ? {} : { audience: [actorId] })
    });
}
