"use server";

/**
 * Server templates from the server page: keep templates, assign them, check a
 * server against one and put its drift back. Every action needs the permission
 * the rest of Servers does, and every input is read through its schema here.
 * Failures come back as a code the screen words (`templates.errors.*`).
 */

import { z } from "zod";
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import * as templates from "@/lib/server-templates/service";
import {
    hostTemplateIdSchema,
    hostTemplateInputSchema,
    templateAssignInputSchema,
    templateFixInputSchema,
    type HostTemplateInput
} from "@polaris/core";

type Result<T = undefined> = { ok: true; value: T } | { ok: false; error: string };

function refused(error: unknown): { ok: false; error: string } {
    if (error instanceof templates.TemplateRefusal) return { ok: false, error: error.code };
    if (error instanceof z.ZodError) return { ok: false, error: "invalid" };
    console.error("[server-templates] action failed", error);
    return { ok: false, error: "failed" };
}

export async function listTemplatesAction(): Promise<Result<templates.TemplateView[]>> {
    const user = await requirePermission("system.manage");
    try {
        return { ok: true, value: await templates.listTemplates(user.id) };
    } catch (error) {
        return refused(error);
    }
}

export async function saveTemplateAction(id: string | null, input: HostTemplateInput): Promise<Result<string>> {
    const user = await requirePermission("system.manage");
    try {
        const templateId = id === null ? null : hostTemplateIdSchema.parse(id);
        const saved = await templates.saveTemplate(user.id, templateId, hostTemplateInputSchema.parse(input));
        return { ok: true, value: saved };
    } catch (error) {
        return refused(error);
    }
}

export async function deleteTemplateAction(id: string): Promise<Result> {
    const user = await requirePermission("system.manage");
    try {
        await templates.deleteTemplate(user.id, hostTemplateIdSchema.parse(id));
        return { ok: true, value: undefined };
    } catch (error) {
        return refused(error);
    }
}

export async function hostAssignmentsAction(hostId: string): Promise<Result<templates.AssignmentView[]>> {
    const user = await requirePermission("system.manage");
    try {
        return { ok: true, value: await templates.hostAssignments(user.id, z.string().uuid().parse(hostId)) };
    } catch (error) {
        return refused(error);
    }
}

export async function assignTemplateAction(input: z.input<typeof templateAssignInputSchema>): Promise<Result<templates.AssignmentView>> {
    const user = await requirePermission("system.manage");
    try {
        const parsed = templateAssignInputSchema.parse(input);
        const id = await templates.assignTemplate(user.id, parsed.templateId, parsed.hostId, parsed.autoFix);
        return { ok: true, value: await templates.checkAssignment(user.id, id) };
    } catch (error) {
        return refused(error);
    }
}

export async function unassignTemplateAction(assignmentId: string): Promise<Result> {
    const user = await requirePermission("system.manage");
    try {
        await templates.unassignTemplate(user.id, z.string().uuid().parse(assignmentId));
        return { ok: true, value: undefined };
    } catch (error) {
        return refused(error);
    }
}

export async function setAutoFixAction(assignmentId: string, autoFix: boolean): Promise<Result> {
    const user = await requirePermission("system.manage");
    try {
        await templates.setAutoFix(user.id, z.string().uuid().parse(assignmentId), z.boolean().parse(autoFix));
        return { ok: true, value: undefined };
    } catch (error) {
        return refused(error);
    }
}

export async function checkAssignmentAction(assignmentId: string): Promise<Result<templates.AssignmentView>> {
    const user = await requirePermission("system.manage");
    try {
        return { ok: true, value: await templates.checkAssignment(user.id, z.string().uuid().parse(assignmentId)) };
    } catch (error) {
        return refused(error);
    }
}

export async function fixAssignmentAction(input: z.input<typeof templateFixInputSchema>): Promise<Result<templates.AssignmentView>> {
    const user = await requirePermission("system.manage");
    try {
        const parsed = templateFixInputSchema.parse(input);
        const result = await templates.fixAssignment(user.id, parsed.assignmentId, parsed.keys);
        await recordAudit({
            actorId: user.id,
            action: "host.template.fix",
            targetType: "hostTemplateAssignment",
            targetId: parsed.assignmentId,
            metadata: { items: parsed.keys ?? "all", status: result.status }
        });
        return { ok: true, value: result };
    } catch (error) {
        return refused(error);
    }
}
