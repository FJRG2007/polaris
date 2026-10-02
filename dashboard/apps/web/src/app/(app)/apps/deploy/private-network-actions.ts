"use server";

/**
 * A service's private names and the links that let another project call it.
 *
 * Reading takes seeing the project; every change takes `service.configure` on
 * the service - and, for a link between two projects, on the other service as
 * well, so nobody opens a way into a project they could not configure. A change
 * redeploys an application so its container answers to the new names; a running
 * database takes them on its next deploy, and a service never deployed on its
 * first.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import * as names from "@/lib/deploy/private-names";
import { getTranslations } from "@/lib/i18n/request";
import { recordDeployAudit } from "@/lib/deploy-audit";
import type { ProjectCapability } from "@polaris/core";
import { requireApplicationAccess, requireDatabaseAccess } from "@/lib/deploy-project-access";
import { PRIVATE_ALIASES_MAX, PRIVATE_NAME_MAX, type PrivateNameProblem } from "@polaris/core";

const DEPLOY_PATH = "/apps/deploy";

const kindSchema = z.enum(["application", "database"]);
const idSchema = z.string().uuid();
const nameSchema = z.string().max(PRIVATE_NAME_MAX * 2);
const aliasesSchema = z.array(nameSchema).max(PRIVATE_ALIASES_MAX);

type Kind = z.infer<typeof kindSchema>;

const PROBLEM_KEYS = {
    empty: "problems.empty",
    tooLong: "problems.tooLong",
    characters: "problems.characters",
    edges: "problems.edges",
    letter: "problems.letter",
    reserved: "problems.reserved"
} as const satisfies Record<PrivateNameProblem, string>;

async function words() {
    return getTranslations("deployPrivateNet");
}

/** The service, checked: a real id of a kind it is, reachable by this user with
 *  this capability, and the environment it is in. */
async function reach(kind: unknown, id: unknown, userId: string, capability: ProjectCapability) {
    const parsed = z.object({ kind: kindSchema, id: idSchema }).safeParse({ kind, id });
    if (!parsed.success) throw new Error("Service not found");
    const access =
        parsed.data.kind === "application"
            ? await requireApplicationAccess(parsed.data.id, userId, capability)
            : await requireDatabaseAccess(parsed.data.id, userId, capability);
    return { kind: parsed.data.kind, id: parsed.data.id, environmentId: access.environmentId };
}

/** A refusal in the reader's words. */
async function refusal(caught: unknown): Promise<string> {
    const t = await words();
    if (caught instanceof names.PrivateNameRefusal) {
        if (caught.reason === "taken") return t("taken", { service: caught.takenBy ?? "" });
        if (caught.reason === "tooMany") return t("tooManyAliases", { max: PRIVATE_ALIASES_MAX });
        if (caught.reason === "unchanged") return t("unchanged");
        return t(PROBLEM_KEYS[caught.reason]);
    }
    if (caught instanceof names.PrivateLinkRefusal) return t(`linkRefused.${caught.reason}`);
    console.error("polaris: a private network change failed:", caught);
    return t("failed");
}

export async function privateNetworkAction(
    kind: Kind,
    id: string
): Promise<{ view?: names.PrivateNetworkView; canEdit?: boolean; error?: string }> {
    const user = await requirePermission("deploy.read");
    try {
        const service = await reach(kind, id, user.id, "project.read");
        const canEdit = await reach(kind, id, user.id, "service.configure").then(
            () => true,
            () => false
        );
        return { view: await names.privateNetworkView(service.kind, service.id), canEdit };
    } catch (caught) {
        console.error("polaris: a private network could not be read:", caught);
        return { error: (await words())("loadFailed") };
    }
}

/** Whether a name is free, as it is typed. */
export async function checkPrivateNameAction(
    kind: Kind,
    id: string,
    name: string
): Promise<{ name?: string; available?: boolean; message?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = nameSchema.safeParse(name);
    const t = await words();
    if (!parsed.success) return { available: false, message: t(PROBLEM_KEYS.tooLong) };
    try {
        const service = await reach(kind, id, user.id, "service.configure");
        const check = await names.checkPrivateName(
            service.kind,
            service.id,
            service.environmentId,
            parsed.data
        );
        if (check.problem)
            return { name: check.name, available: false, message: t(PROBLEM_KEYS[check.problem]) };
        if (check.takenBy)
            return {
                name: check.name,
                available: false,
                message: t("taken", { service: check.takenBy })
            };
        return { name: check.name, available: true };
    } catch (caught) {
        return { available: false, message: await refusal(caught) };
    }
}

export async function renamePrivateNameAction(
    kind: Kind,
    id: string,
    name: string
): Promise<{ error?: string; applied?: names.NamesApplied }> {
    const user = await requirePermission("deploy.manage");
    const parsed = nameSchema.safeParse(name);
    if (!parsed.success) return { error: (await words())(PROBLEM_KEYS.tooLong) };
    try {
        const service = await reach(kind, id, user.id, "service.configure");
        const renamed = await names.renamePrivateName(service.kind, service.id, parsed.data);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.private-name.rename",
            targetType: service.kind === "application" ? "application" : "database",
            targetId: service.id,
            metadata: { from: renamed.previous, to: renamed.name }
        });
        const applied = await names.redeployForNames(service.kind, service.id, user.id);
        revalidatePath(DEPLOY_PATH);
        return { applied };
    } catch (caught) {
        return { error: await refusal(caught) };
    }
}

export async function setPrivateAliasesAction(
    kind: Kind,
    id: string,
    aliases: string[]
): Promise<{ error?: string; applied?: names.NamesApplied }> {
    const user = await requirePermission("deploy.manage");
    const parsed = aliasesSchema.safeParse(aliases);
    if (!parsed.success)
        return { error: (await words())("tooManyAliases", { max: PRIVATE_ALIASES_MAX }) };
    try {
        const service = await reach(kind, id, user.id, "service.configure");
        const saved = await names.setPrivateAliases(service.kind, service.id, parsed.data);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.private-name.aliases",
            targetType: service.kind === "application" ? "application" : "database",
            targetId: service.id,
            metadata: { aliases: saved }
        });
        const applied = await names.redeployForNames(service.kind, service.id, user.id);
        revalidatePath(DEPLOY_PATH);
        return { applied };
    } catch (caught) {
        return { error: await refusal(caught) };
    }
}

export async function crossLinkCandidatesAction(
    kind: Kind,
    id: string
): Promise<{ candidates?: names.CrossLinkCandidate[]; error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        const service = await reach(kind, id, user.id, "service.configure");
        return { candidates: await names.crossLinkCandidates(service.kind, service.id, user.id) };
    } catch (caught) {
        return { error: await refusal(caught) };
    }
}

/** Let an application of another project call this service by name. */
export async function addCrossLinkAction(
    kind: Kind,
    id: string,
    sourceId: string
): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        const service = await reach(kind, id, user.id, "service.configure");
        const source = await reach("application", sourceId, user.id, "service.configure");
        await names.addCrossLink(service.kind, service.id, source.id, user.id);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.private-link.add",
            targetType: service.kind === "application" ? "application" : "database",
            targetId: service.id,
            metadata: { from: source.id }
        });
        // Both join the link's network on their next start.
        await names.redeployForNames(service.kind, service.id, user.id);
        await names.redeployForNames("application", source.id, user.id);
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: await refusal(caught) };
    }
}

/** Close a link between two projects, from either side. */
export async function removeCrossLinkAction(
    kind: Kind,
    id: string,
    linkId: string
): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        const service = await reach(kind, id, user.id, "service.configure");
        const link = idSchema.safeParse(linkId).success ? await names.crossLinkOf(linkId) : null;
        const own =
            link &&
            ((link.targetKind === service.kind && link.targetId === service.id) ||
                (service.kind === "application" && link.sourceId === service.id));
        if (!link || !own) return { error: (await words())("linkRefused.missing") };
        // Closed on the server before anything says it is: refused, and kept on
        // record, when the server cannot be told.
        await names.revokeCrossLink(link);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.private-link.remove",
            targetType: service.kind === "application" ? "application" : "database",
            targetId: service.id,
            metadata: { target: link.targetId, source: link.sourceId }
        });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: await refusal(caught) };
    }
}
