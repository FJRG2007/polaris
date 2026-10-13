"use server";

/**
 * A kind of record's workflows: list them, save one, switch one on or off,
 * delete one. Every input is checked against its schema here, and every rule
 * about who may do what is in `lib/`.
 */

import { z } from "zod";
import * as workflows from "../lib/workflows";
import { CRM_OBJECTS } from "../model/objects";
import { requireCrmActor } from "../lib/access";
import { invalid, outcome, type Outcome } from "../lib/outcome";
import {
    workflowInputSchema,
    type SavedWorkflow,
    type WorkflowOptions,
    type WorkflowView
} from "../model/workflows";

const object = z.enum(CRM_OBJECTS);
const one = z.object({ object, id: z.string().uuid() });

/** The workflows of a kind of record. */
export async function listWorkflowsAction(
    input: unknown
): Promise<Outcome<{ workflows: WorkflowView[] }>> {
    const parsed = z.object({ object }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        workflows: await workflows.listWorkflows(await requireCrmActor(), parsed.data.object)
    }));
}

/** The task lists and people the editor offers. */
export async function workflowOptionsAction(input: unknown): Promise<Outcome<WorkflowOptions>> {
    const parsed = z.object({ object }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => workflows.workflowOptions(await requireCrmActor()));
}

/** Make a workflow, or change one. */
export async function saveWorkflowAction(input: unknown): Promise<Outcome<SavedWorkflow>> {
    const parsed = z.object({ object, workflow: workflowInputSchema }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () =>
        workflows.saveWorkflow(await requireCrmActor(), parsed.data.object, parsed.data.workflow)
    );
}

/** Switch a workflow on or off. */
export async function setWorkflowEnabledAction(
    input: unknown
): Promise<Outcome<{ enabled: boolean }>> {
    const parsed = one.extend({ enabled: z.boolean() }).safeParse(input);
    if (!parsed.success) return invalid();
    const { object: kind, id, enabled } = parsed.data;
    return outcome(async () => {
        await workflows.setWorkflowEnabled(await requireCrmActor(), kind, id, enabled);
        return { enabled };
    });
}

/** Delete a workflow. */
export async function deleteWorkflowAction(input: unknown): Promise<Outcome<{ deleted: true }>> {
    const parsed = one.safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        await workflows.deleteWorkflow(await requireCrmActor(), parsed.data.object, parsed.data.id);
        return { deleted: true as const };
    });
}

/** The workflows a record's page can run by hand. */
export async function listManualWorkflowsAction(
    input: unknown
): Promise<Outcome<{ workflows: { id: string; name: string }[] }>> {
    const parsed = z.object({ object }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        workflows: await workflows.listManualWorkflows(await requireCrmActor(), parsed.data.object)
    }));
}

/** Run a manual workflow on a record. */
export async function runManualWorkflowAction(
    input: unknown
): Promise<Outcome<{ error: string | null }>> {
    const parsed = one.extend({ workflowId: z.string().uuid() }).safeParse(input);
    if (!parsed.success) return invalid();
    const { object: kind, id, workflowId } = parsed.data;
    return outcome(async () =>
        workflows.runManualWorkflow(await requireCrmActor(), kind, id, workflowId)
    );
}
