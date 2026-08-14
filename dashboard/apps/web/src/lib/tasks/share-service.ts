/**
 * Sending one task somewhere it can be read.
 *
 * Three ways out, because they answer three different questions. The private
 * link is the task's own page and opens for anybody who already reaches the
 * space - it is what you paste into a chat with a colleague. The public link is
 * a token that renders a read-only page to anyone holding it, for the client who
 * has no account and only wants to know where their thing is. Email is not a
 * fourth kind of access: it carries whichever of those two links the recipient
 * can actually use, which is why an address outside Polaris cannot be sent
 * anything until the public link is on.
 *
 * The public projection is built here rather than reusing the panel's, so
 * widening what the panel shows can never widen what the world sees. Nothing on
 * it carries an id, a space, a list or a custom field.
 */

import * as access from "./access";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { sendAuthEmail } from "@/lib/auth-mail";
import { generateToken } from "@polaris/core/tokens";
import * as follow from "@/lib/follow/follow";
import { notify } from "@/lib/notifications/dispatch";
import { appBaseUrl, sharingBaseUrl } from "@/lib/domain-service";

/** A task's public link as its owner sees it. */
export interface TaskShareView {
    readonly url: string;
    readonly showComments: boolean;
    /** How often the link has been opened, so a dead link reads as dead. */
    readonly views: number;
    readonly createdAt: string;
}

/** The link to the task inside Polaris. Only resolves for people with access,
 *  which is exactly what makes it the safe one to paste internally. */
export async function taskLink(taskId: string): Promise<string> {
    return `${(await appBaseUrl()).replace(/\/+$/, "")}/tasks/t/${taskId}`;
}

async function publicUrl(token: string): Promise<string> {
    return `${(await sharingBaseUrl()).replace(/\/+$/, "")}/t/${token}`;
}

async function toShareView(share: {
    token: string;
    showComments: boolean;
    views: number;
    createdAt: Date;
}): Promise<TaskShareView> {
    return {
        url: await publicUrl(share.token),
        showComments: share.showComments,
        views: share.views,
        createdAt: share.createdAt.toISOString()
    };
}

export async function getTaskShare(taskId: string): Promise<TaskShareView | null> {
    const share = await prisma.taskShare.findUnique({
        where: { taskId },
        select: { token: true, showComments: true, views: true, createdAt: true }
    });
    return share ? toShareView(share) : null;
}

/**
 * Turn the public link on or off. Off deletes the row: a link somebody has
 * already pasted somewhere should stop working for good, so switching it back on
 * later mints a new token rather than reviving the old one.
 */
export async function setTaskShare(
    actorId: string,
    input: core.TaskShareInput
): Promise<TaskShareView | null> {
    if (!input.enabled) {
        await prisma.taskShare.deleteMany({ where: { taskId: input.taskId } });
        return null;
    }
    const share = await prisma.taskShare.upsert({
        where: { taskId: input.taskId },
        update: { showComments: input.showComments },
        create: {
            taskId: input.taskId,
            token: generateToken(),
            showComments: input.showComments,
            createdById: actorId
        },
        select: { token: true, showComments: true, views: true, createdAt: true }
    });
    return toShareView(share);
}

// ---------------------------------------------------------------------------
// The public page
// ---------------------------------------------------------------------------

/** What a person holding the link is shown. Names only: no ids, and nothing
 *  about where in the instance the work lives. */
export interface PublicTaskView {
    readonly reference: string;
    readonly name: string;
    readonly description: string;
    readonly statusName: string;
    readonly statusColor: string;
    readonly finished: boolean;
    readonly priority: core.TaskPriority;
    readonly assignees: string[];
    readonly tags: { readonly name: string; readonly color: string }[];
    readonly startDate: string | null;
    readonly dueDate: string | null;
    readonly timed: boolean;
    readonly points: number | null;
    readonly subtasks: {
        readonly name: string;
        readonly statusName: string;
        readonly statusColor: string;
        readonly finished: boolean;
    }[];
    readonly checklists: {
        readonly name: string;
        readonly items: { readonly name: string; readonly done: boolean }[];
    }[];
    /** Present only when the sharer chose to include the discussion. */
    readonly comments: { readonly author: string; readonly body: string; readonly createdAt: string }[] | null;
    readonly createdAt: string;
    readonly updatedAt: string;
}

const PUBLIC_STATUS = { select: { name: true, color: true, type: true } } as const;

function finishedStatus(type: string | undefined): boolean {
    return type ? core.isFinishedStatus(type as core.TaskStatusType) : false;
}

/**
 * Resolve a public link. Counts the view before returning, so an owner can tell
 * whether the link they sent was ever opened. An unknown token and a link that
 * was turned off are the same answer: null, which the page renders identically
 * so the URL cannot be used to test which tokens exist.
 */
export async function getPublicTask(token: string): Promise<PublicTaskView | null> {
    const share = await prisma.taskShare.findUnique({
        where: { token },
        select: {
            id: true,
            showComments: true,
            task: {
                select: {
                    id: true,
                    number: true,
                    name: true,
                    description: true,
                    priority: true,
                    startDate: true,
                    dueDate: true,
                    timed: true,
                    points: true,
                    createdAt: true,
                    updatedAt: true,
                    space: { select: { prefix: true } },
                    status: PUBLIC_STATUS,
                    assignees: { select: { user: { select: { name: true } } } },
                    tags: { select: { tag: { select: { name: true, color: true } } } },
                    subtasks: {
                        where: { archived: false },
                        orderBy: { order: "asc" },
                        select: { name: true, status: PUBLIC_STATUS }
                    },
                    checklists: {
                        orderBy: { order: "asc" },
                        select: {
                            name: true,
                            items: { orderBy: { order: "asc" }, select: { name: true, done: true } }
                        }
                    }
                }
            }
        }
    });
    if (!share) return null;

    const task = share.task;
    const comments = share.showComments
        ? await prisma.comment.findMany({
              where: { subjectType: "task", subjectId: task.id },
              orderBy: { createdAt: "asc" },
              take: 200,
              select: { body: true, createdAt: true, user: { select: { name: true } } }
          })
        : null;

    await prisma.taskShare.update({ where: { id: share.id }, data: { views: { increment: 1 } } });

    return {
        reference: core.taskReference(task.space.prefix, task.number),
        name: task.name,
        description: task.description,
        statusName: task.status?.name ?? "No status",
        statusColor: task.status?.color ?? "#64748b",
        finished: finishedStatus(task.status?.type),
        priority: task.priority as core.TaskPriority,
        assignees: task.assignees.map((entry) => entry.user.name),
        tags: task.tags.map((entry) => entry.tag),
        startDate: task.startDate?.toISOString() ?? null,
        dueDate: task.dueDate?.toISOString() ?? null,
        timed: task.timed,
        points: task.points,
        subtasks: task.subtasks.map((subtask) => ({
            name: subtask.name,
            statusName: subtask.status?.name ?? "No status",
            statusColor: subtask.status?.color ?? "#64748b",
            finished: finishedStatus(subtask.status?.type)
        })),
        checklists: task.checklists,
        comments:
            comments?.map((comment) => ({
                author: comment.user?.name ?? "Automation",
                body: comment.body,
                createdAt: comment.createdAt.toISOString()
            })) ?? null,
        createdAt: task.createdAt.toISOString(),
        updatedAt: task.updatedAt.toISOString()
    };
}

// ---------------------------------------------------------------------------
// Sending it to people
// ---------------------------------------------------------------------------

/** What became of one send, per recipient, so the dialog can say which address
 *  it could not reach rather than failing the whole batch. */
export interface ShareDelivery {
    readonly sent: string[];
    readonly failures: { readonly recipient: string; readonly reason: string }[];
}

function outsiderMessage(input: {
    sender: string;
    reference: string;
    name: string;
    note: string;
    url: string;
}): { subject: string; text: string; html: string } {
    const escape = (value: string): string =>
        value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const text = [
        `${input.sender} shared a task with you: ${input.reference} ${input.name}`,
        ...(input.note ? ["", input.note] : []),
        "",
        input.url,
        "",
        "The link is read-only and can be turned off at any time."
    ].join("\n");
    const html = [
        `<p>${escape(input.sender)} shared a task with you.</p>`,
        `<p><strong>${escape(input.reference)} ${escape(input.name)}</strong></p>`,
        input.note ? `<p>${escape(input.note)}</p>` : "",
        `<p><a href="${escape(input.url)}">Open the task</a></p>`,
        "<p>The link is read-only and can be turned off at any time.</p>"
    ].join("");
    return { subject: `${input.sender} shared "${input.name}" with you`, text, html };
}

/**
 * Send a task to people. A recipient who already has an account is told inside
 * Polaris and gets the private link; anybody else gets the public one, and only
 * if it has been turned on - emailing a link the recipient cannot open is a way
 * to look like you shared something when you did not.
 *
 * Sending also starts the recipient watching the task: having been handed it,
 * they should hear what happens to it next.
 */
export async function sendTaskByEmail(
    sender: { id: string; name: string },
    input: core.TaskShareEmailInput
): Promise<ShareDelivery> {
    const task = await prisma.task.findUnique({
        where: { id: input.taskId },
        select: { name: true, number: true, space: { select: { prefix: true } } }
    });
    if (!task) throw new Error("That task no longer exists");
    const reference = core.taskReference(task.space.prefix, task.number);

    // An address that belongs to an account is that account: it should get the
    // in-app alert and the private link, not a public token it does not need.
    const byAddress = input.emails.length
        ? await prisma.user.findMany({
              where: { email: { in: input.emails } },
              select: { id: true, email: true }
          })
        : [];
    const knownAddress = new Map(byAddress.map((user) => [user.email, user.id]));
    const memberIds = [...new Set([...input.userIds, ...byAddress.map((user) => user.id)])];
    const outsiders = input.emails.filter((address) => !knownAddress.has(address));

    const sent: string[] = [];
    const failures: { recipient: string; reason: string }[] = [];

    const members = memberIds.length
        ? await prisma.user.findMany({
              where: { id: { in: memberIds } },
              select: { id: true, name: true, email: true, isAdmin: true }
          })
        : [];

    for (const member of members) {
        if (member.id === sender.id) continue;
        // The same authority the app itself uses, asked on their behalf: a link
        // to a space they cannot reach would only tell them it exists.
        try {
            await access.requireTask({ id: member.id, isAdmin: member.isAdmin }, input.taskId, "guest");
        } catch {
            failures.push({ recipient: member.name, reason: "They do not have access to this space" });
            continue;
        }
        await follow.follow("task", input.taskId, member.id, "explicit");
        await notify({
            userId: member.id,
            event: "tasks.shared",
            title: `${sender.name} sent you ${reference}: ${task.name}`,
            body: input.note || null,
            href: `/tasks/t/${input.taskId}`
        });
        sent.push(member.name);
    }

    if (outsiders.length > 0) {
        const share = await prisma.taskShare.findUnique({
            where: { taskId: input.taskId },
            select: { token: true }
        });
        if (!share) {
            for (const address of outsiders) {
                failures.push({ recipient: address, reason: "Turn the public link on to email someone outside Polaris" });
            }
        } else {
            const url = await publicUrl(share.token);
            const message = outsiderMessage({
                sender: sender.name,
                reference,
                name: task.name,
                note: input.note,
                url
            });
            for (const address of outsiders) {
                const result = await sendAuthEmail({ to: address, ...message });
                if (result.error) failures.push({ recipient: address, reason: result.error });
                else sent.push(address);
            }
        }
    }

    return { sent, failures };
}
