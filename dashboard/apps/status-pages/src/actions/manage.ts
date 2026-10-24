"use server";

/**
 * Everything the status pages screen asks the server. Each action validates its
 * input before any work, and requires `status.manage` (inside `outcome`) or -
 * for what happens on one page - that page shared with the caller to edit
 * (inside `pageOutcome`, `lib/page-access`).
 */

import { z } from "zod";
import * as manage from "../lib/manage";
import { invalid, outcome, settle, type Outcome } from "../lib/outcome";
import { host } from "@polaris/app-host";
import { editablePageIds, isStatusManager, pageOutcome } from "../lib/page-access";
import { publicStatusPage, type PublicStatusPage } from "../lib/public";
import {
    checkInput,
    componentInput,
    customDomainInput,
    idInput,
    incidentInput,
    incidentUpdateInput,
    maintenanceInput,
    pageInput
} from "../model/schemas";

const optionalId = z.object({ id: z.string().uuid().nullable() });

export async function listPagesAction(): Promise<
    Outcome<{ pages: manage.PageSummary[]; manager: boolean }>
> {
    let manager = false;
    return settle(
        async () => {
            const user = await host.session.requireUser();
            manager = await isStatusManager(user);
            return user;
        },
        async (userId) =>
            manager
                ? { pages: await manage.listPages(), manager }
                : { pages: await manage.listPages(await editablePageIds(userId)), manager }
    );
}

export async function pageDetailAction(
    input: unknown
): Promise<Outcome<{ page: manage.PageDetail }>> {
    const parsed = idInput.safeParse(input);
    if (!parsed.success) return invalid();
    return pageOutcome([{ page: parsed.data.id }], async () => ({
        page: await manage.pageDetail(parsed.data.id)
    }));
}

export async function previewAction(
    input: unknown
): Promise<Outcome<{ view: PublicStatusPage | null }>> {
    const parsed = z.object({ slug: z.string().max(60) }).safeParse(input);
    if (!parsed.success) return invalid();
    return pageOutcome([{ slug: parsed.data.slug }], async () => ({
        view: await publicStatusPage(parsed.data.slug, new Date(), { includeUnpublished: true })
    }));
}

export async function savePageAction(input: unknown): Promise<Outcome<{ id: string }>> {
    const id = optionalId.safeParse(input);
    const page = pageInput.safeParse(input);
    if (!id.success || !page.success) return invalid();
    // A new page is made by whoever runs status pages; an existing one is
    // also kept by the people it was shared with.
    const pageId = id.data.id;
    if (!pageId) return outcome((userId) => manage.savePage(null, page.data, userId));
    return pageOutcome([{ page: pageId }], (userId) => manage.savePage(pageId, page.data, userId));
}

export async function deletePageAction(input: unknown): Promise<Outcome<object>> {
    const parsed = idInput.safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => {
        await manage.deletePage(parsed.data.id);
        return {};
    });
}

export async function saveComponentAction(input: unknown): Promise<Outcome<{ id: string }>> {
    const id = optionalId.safeParse(input);
    const component = componentInput.safeParse(input);
    if (!id.success || !component.success) return invalid();
    const targets = [
        { page: component.data.pageId },
        ...(id.data.id ? [{ components: [id.data.id] }] : [])
    ];
    return pageOutcome(targets, async () => {
        if (id.data.id) {
            await manage.updateComponent(id.data.id, component.data);
            return { id: id.data.id };
        }
        return manage.addComponent(component.data);
    });
}

export async function deleteComponentAction(input: unknown): Promise<Outcome<object>> {
    const parsed = idInput.safeParse(input);
    if (!parsed.success) return invalid();
    return pageOutcome([{ components: [parsed.data.id] }], async () => {
        await manage.deleteComponent(parsed.data.id);
        return {};
    });
}

export async function saveCheckAction(input: unknown): Promise<Outcome<{ id: string }>> {
    const id = optionalId.safeParse(input);
    const check = checkInput.safeParse(input);
    if (!id.success || !check.success) return invalid();
    const checkId = id.data.id;
    const targets = [
        { components: [check.data.componentId] },
        ...(checkId ? [{ check: checkId }] : [])
    ];
    return pageOutcome(targets, () => manage.saveCheck(checkId, check.data));
}

export async function deleteCheckAction(input: unknown): Promise<Outcome<object>> {
    const parsed = idInput.safeParse(input);
    if (!parsed.success) return invalid();
    return pageOutcome([{ check: parsed.data.id }], async () => {
        await manage.deleteCheck(parsed.data.id);
        return {};
    });
}

export async function openIncidentAction(input: unknown): Promise<Outcome<{ id: string }>> {
    const parsed = incidentInput.safeParse(input);
    if (!parsed.success) return invalid();
    return pageOutcome(
        [{ page: parsed.data.pageId }, { components: parsed.data.componentIds }],
        () => manage.openIncident(parsed.data)
    );
}

export async function postIncidentUpdateAction(input: unknown): Promise<Outcome<object>> {
    const parsed = incidentUpdateInput.safeParse(input);
    if (!parsed.success) return invalid();
    return pageOutcome([{ incident: parsed.data.incidentId }], async () => {
        await manage.postIncidentUpdate(parsed.data);
        return {};
    });
}

export async function deleteIncidentAction(input: unknown): Promise<Outcome<object>> {
    const parsed = idInput.safeParse(input);
    if (!parsed.success) return invalid();
    return pageOutcome([{ incident: parsed.data.id }], async () => {
        await manage.deleteIncident(parsed.data.id);
        return {};
    });
}

export async function saveMaintenanceAction(input: unknown): Promise<Outcome<{ id: string }>> {
    const parsed = maintenanceInput.safeParse(input);
    if (!parsed.success) return invalid();
    return pageOutcome(
        [{ page: parsed.data.pageId }, { components: parsed.data.componentIds }],
        () => manage.saveMaintenance(parsed.data)
    );
}

export async function deleteMaintenanceAction(input: unknown): Promise<Outcome<object>> {
    const parsed = idInput.safeParse(input);
    if (!parsed.success) return invalid();
    return pageOutcome([{ maintenance: parsed.data.id }], async () => {
        await manage.deleteMaintenance(parsed.data.id);
        return {};
    });
}

export async function setCustomDomainAction(
    input: unknown
): Promise<Outcome<{ status: manage.DomainStatus | null }>> {
    const parsed = customDomainInput.safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        status: await manage.setCustomDomain(parsed.data.id, parsed.data.domain)
    }));
}

export async function checkCustomDomainAction(
    input: unknown
): Promise<Outcome<{ status: manage.DomainStatus | null }>> {
    const parsed = idInput.safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({ status: await manage.checkCustomDomain(parsed.data.id) }));
}

export async function deployedTargetsAction(): Promise<
    Outcome<{ targets: { label: string; url: string }[] }>
> {
    return outcome(async () => ({ targets: await manage.deployedTargets() }));
}
