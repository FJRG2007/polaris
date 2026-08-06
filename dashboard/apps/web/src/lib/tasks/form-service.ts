/**
 * Intake forms: a public page that files what it collects as a task.
 *
 * The token in the URL is the whole credential, so it is random rather than
 * derived from the form id, and revoking a form means deleting it. Answers are
 * kept alongside the task the submission opened: a question that was not mapped
 * to a field still has to be readable afterwards, and appending it to the
 * description is how the person triaging actually sees it.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { createTask } from "./task-service";
import { generateToken } from "@polaris/core/tokens";

export interface FormView {
    readonly id: string;
    readonly name: string;
    readonly token: string;
    readonly listId: string;
    readonly listName: string;
    readonly intro: string;
    readonly fields: core.FormField[];
    readonly confirmation: string;
    readonly requireLogin: boolean;
    readonly enabled: boolean;
    readonly submissionCount: number;
}

function parseFields(raw: string): core.FormField[] {
    try {
        const parsed = core.formFieldSchema.array().safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : [];
    } catch {
        return [];
    }
}

export async function listForms(spaceId: string): Promise<FormView[]> {
    const forms = await prisma.taskForm.findMany({
        where: { spaceId },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            name: true,
            token: true,
            listId: true,
            intro: true,
            fields: true,
            confirmation: true,
            requireLogin: true,
            enabled: true,
            list: { select: { name: true } },
            _count: { select: { submissions: true } }
        }
    });
    return forms.map((form) => ({
        id: form.id,
        name: form.name,
        token: form.token,
        listId: form.listId,
        listName: form.list.name,
        intro: form.intro,
        fields: parseFields(form.fields),
        confirmation: form.confirmation,
        requireLogin: form.requireLogin,
        enabled: form.enabled,
        submissionCount: form._count.submissions
    }));
}

export async function createForm(spaceId: string, actorId: string, input: core.FormInput): Promise<string> {
    const form = await prisma.taskForm.create({
        data: {
            spaceId,
            listId: input.listId,
            token: generateToken(),
            name: input.name,
            intro: input.intro,
            fields: JSON.stringify(input.fields),
            defaultStatusId: input.defaultStatusId,
            confirmation: input.confirmation,
            requireLogin: input.requireLogin,
            enabled: input.enabled,
            createdById: actorId
        },
        select: { id: true }
    });
    return form.id;
}

export async function updateForm(formId: string, input: core.FormInput): Promise<void> {
    await prisma.taskForm.update({
        where: { id: formId },
        data: {
            listId: input.listId,
            name: input.name,
            intro: input.intro,
            fields: JSON.stringify(input.fields),
            defaultStatusId: input.defaultStatusId,
            confirmation: input.confirmation,
            requireLogin: input.requireLogin,
            enabled: input.enabled
        }
    });
}

export async function deleteForm(formId: string): Promise<void> {
    await prisma.taskForm.delete({ where: { id: formId } });
}

/** What the public page renders. Never includes the list, the space, or
 *  anything else about the workspace behind it. */
export interface PublicForm {
    readonly name: string;
    readonly intro: string;
    readonly fields: core.FormField[];
    readonly confirmation: string;
    readonly requireLogin: boolean;
}

export async function getPublicForm(token: string): Promise<PublicForm | null> {
    const form = await prisma.taskForm.findUnique({
        where: { token },
        select: {
            name: true,
            intro: true,
            fields: true,
            confirmation: true,
            requireLogin: true,
            enabled: true
        }
    });
    if (!form || !form.enabled) return null;
    return {
        name: form.name,
        intro: form.intro,
        fields: parseFields(form.fields),
        confirmation: form.confirmation,
        requireLogin: form.requireLogin
    };
}

/**
 * File a submission as a task.
 *
 * Answers are validated against the form's own questions, not against a shape
 * the client claims: a required question with no answer is refused, and anything
 * sent for a question the form does not have is dropped rather than stored.
 */
export async function submitForm(
    token: string,
    answers: Record<string, string>,
    submittedById: string | null
): Promise<{ ok: true; confirmation: string; spaceId: string } | { ok: false; error: string }> {
    const form = await prisma.taskForm.findUnique({
        where: { token },
        select: {
            id: true,
            spaceId: true,
            listId: true,
            fields: true,
            defaultStatusId: true,
            confirmation: true,
            requireLogin: true,
            enabled: true,
            createdById: true
        }
    });
    if (!form || !form.enabled) return { ok: false, error: "This form is no longer accepting responses" };
    if (form.requireLogin && !submittedById) return { ok: false, error: "Sign in to send this form" };

    const fields = parseFields(form.fields);
    const clean: Record<string, string> = {};
    for (const field of fields) {
        const value = (answers[field.id] ?? "").toString().trim().slice(0, 5000);
        if (field.required && !value) return { ok: false, error: `${field.label} is required` };
        if (value) clean[field.id] = value;
    }

    // Route the answers: the mapped ones into task fields, the rest into the
    // description so nothing a person typed is thrown away.
    let name = "";
    let description = "";
    let priority: core.TaskPriority = "none";
    let dueDate: string | null = null;
    const custom: { fieldId: string; value: string }[] = [];
    const spare: string[] = [];

    for (const field of fields) {
        const value = clean[field.id];
        if (!value) continue;
        switch (field.mapsTo) {
            case "name":
                name = value.slice(0, 255);
                break;
            case "description":
                description = description ? `${description}\n\n${value}` : value;
                break;
            case "priority":
                priority = (core.TASK_PRIORITIES as readonly string[]).includes(value)
                    ? (value as core.TaskPriority)
                    : "none";
                break;
            case "dueDate": {
                const parsed = new Date(value);
                dueDate = Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
                break;
            }
            default:
                if (field.mapsTo) custom.push({ fieldId: field.mapsTo, value });
                else spare.push(`**${field.label}**\n${value}`);
        }
    }

    if (!name) name = fields[0] ? (clean[fields[0].id] ?? "Form submission").slice(0, 255) : "Form submission";
    const body = [description, ...spare].filter(Boolean).join("\n\n");

    // The task has no author: a form submission is not something an account did,
    // and attributing it to whoever built the form would misread the history.
    const created = await createTask(null, form.spaceId, {
        listId: form.listId,
        name,
        description: body,
        parentId: null,
        statusId: form.defaultStatusId,
        priority,
        blockedUntil: null,
        blockedNote: "",
        assigneeIds: [],
        tagIds: [],
        startDate: null,
        dueDate,
        timed: false,
        timeEstimate: null,
        points: null,
        sprintId: null,
        milestone: false,
        recurrence: null
    });

    for (const value of custom) {
        await prisma.taskCustomFieldValue
            .create({ data: { taskId: created.id, fieldId: value.fieldId, value: value.value } })
            .catch(() => undefined);
    }
    await prisma.taskFormSubmission.create({
        data: {
            formId: form.id,
            taskId: created.id,
            answers: JSON.stringify(clean),
            submittedById
        }
    });

    // The space rides back so the caller can tell the team a request arrived
    // without looking the form up again.
    return {
        ok: true,
        confirmation: form.confirmation || "Thanks. Your request has been received.",
        spaceId: form.spaceId
    };
}
