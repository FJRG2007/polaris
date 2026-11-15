"use server";

/**
 * What the CRM still answers about automations: the choices its steps offer
 * in the central editor, starting one on a kind of record, and running one by
 * hand on a record. Building and changing them is the Automations app's. Every
 * input is checked against its schema here, and every rule about who may do
 * what is in `lib/`.
 */

import { z } from "zod";
import { crmT } from "../lib/i18n";
import { host } from "@polaris/app-host";
import { loadFields } from "../lib/fields";
import { CrmRefusal } from "../lib/errors";
import * as workflows from "../lib/workflows";
import { workflowGraph } from "../model/automation-nodes";
import type { WorkflowOptions } from "../model/workflows";
import { requireCan, requireCrmActor } from "../lib/access";
import { CRM_OBJECTS, type FieldDef } from "../model/objects";
import { invalid, outcome, type Outcome } from "../lib/outcome";

const object = z.enum(CRM_OBJECTS);
const one = z.object({ object, id: z.string().uuid() });

/** The task lists and people the editor offers. */
export async function workflowOptionsAction(input: unknown): Promise<Outcome<WorkflowOptions>> {
    const parsed = z.object({ object }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => workflows.workflowOptions(await requireCrmActor()));
}

/** What a CRM step's fields in the central editor need: the shelf, its custom fields and the choices. */
export async function automationNodeContextAction(input: unknown): Promise<
    Outcome<{
        orgId: string | null;
        custom: FieldDef[];
        options: WorkflowOptions;
    }>
> {
    const parsed = z.object({ object }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        const actor = await requireCrmActor();
        const [custom, options] = await Promise.all([
            loadFields(actor.shelf, parsed.data.object),
            workflows.workflowOptions(actor)
        ]);
        return { orgId: actor.shelf.orgId, custom, options };
    });
}

/** Start an automation on a kind of record, in the central editor; the reader lands on it. */
export async function startCrmAutomationAction(
    input: unknown
): Promise<Outcome<{ automationId: string }>> {
    const parsed = z.object({ object }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        const actor = await requireCrmActor();
        // Building one is what saving a workflow needed: changing that kind of record.
        await requireCan(actor, parsed.data.object, "edit");
        await host.session.requirePermission("automations.use").catch(async () => {
            throw new CrmRefusal((await crmT())("automations.noAccess"));
        });
        const t = await crmT();
        const automationId = await host.automations.startAppAutomation({
            name: t("automations.newName", {
                objects: t(`objects.${parsed.data.object}.plural`)
            }),
            ownerId: actor.user.id,
            origin: "crm",
            originRef: parsed.data.object,
            graph: workflowGraph(actor.shelf.orgId, parsed.data.object, { kind: "created" }, [])
        });
        return { automationId };
    });
}

/** The automations a record's page can run by hand. */
export async function listManualWorkflowsAction(
    input: unknown
): Promise<Outcome<{ workflows: { id: string; name: string }[] }>> {
    const parsed = z.object({ object }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        workflows: await workflows.listManualWorkflows(await requireCrmActor(), parsed.data.object)
    }));
}

/** Run one of them on a record. */
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
