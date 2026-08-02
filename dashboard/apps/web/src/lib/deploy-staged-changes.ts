/**
 * The changeset: destructive edits parked for review instead of applied.
 *
 * Removing a service is the one action in Deploy with no undo behind it - the
 * container goes, the history goes, and the next screen is an empty canvas. So
 * it is recorded here instead, drawn on the canvas as pending, and only carried
 * out when the operator deploys the changeset. That is the Railway model, and it
 * exists for the same reason: the gap between "I clicked delete" and "the data
 * is gone" is where somebody notices they were in production.
 *
 * Only removals stage. A variable, a domain, a port still applies immediately -
 * staging those would mean an operator fixing an outage has to press deploy
 * twice, which is a worse failure than the one this prevents.
 *
 * Applying is deliberately not a transaction. Each change tears down real
 * infrastructure, and a change that succeeds must not be rolled back in the
 * database because a later one failed - the container is already gone. Each is
 * applied and dropped on its own, and what could not be done stays staged with
 * the reason attached.
 */

import { prisma } from "@polaris/db";
import { deleteDatabase } from "./database-service";
import { deleteApplication } from "./deploy-service";
import { deleteVolume } from "./deploy-volume-service";
import {
    parseProjectFlags,
    parseStagedChangePayload,
    type StagedChangeKind,
    type StagedChangePayload
} from "@polaris/core";

/** A staged change as the changeset panel renders it. */
export interface StagedChangeView {
    id: string;
    environmentId: string;
    kind: StagedChangeKind;
    targetType: string;
    targetId: string;
    targetName: string;
    payload: StagedChangePayload;
    createdAt: string;
    /** Detail the panel shows under the name, e.g. the service a volume is on. */
    detail: string | null;
}

/** The outcome of deploying a changeset, per change that would not apply. */
export interface ApplyResult {
    applied: number;
    failures: { targetName: string; error: string }[];
}

function toView(row: {
    id: string;
    environmentId: string;
    kind: string;
    targetType: string;
    targetId: string;
    targetName: string;
    payload: string;
    createdAt: Date;
}): StagedChangeView {
    const payload = parseStagedChangePayload(row.payload);
    return {
        id: row.id,
        environmentId: row.environmentId,
        kind: row.kind as StagedChangeKind,
        targetType: row.targetType,
        targetId: row.targetId,
        targetName: row.targetName,
        payload,
        createdAt: row.createdAt.toISOString(),
        detail:
            row.kind === "volume.delete"
                ? payload.wipe
                    ? "The data in it is destroyed."
                    : "The volume is detached and removed."
                : null
    };
}

/** Whether this project parks its destructive changes at all. Turning the flag
 *  off is a deliberate choice to have deletes take effect as they are clicked. */
export async function projectStagesChanges(projectId: string): Promise<boolean> {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { flags: true } });
    return parseProjectFlags(project?.flags).stageDestructiveChanges;
}

export async function listStagedChanges(environmentId: string): Promise<StagedChangeView[]> {
    const rows = await prisma.stagedChange.findMany({
        where: { environmentId },
        orderBy: { createdAt: "asc" }
    });
    return rows.map(toView);
}

/** Every change staged across a project, so the shell can show one count no
 *  matter which environment the operator is looking at. */
export async function listProjectStagedChanges(projectId: string): Promise<StagedChangeView[]> {
    const rows = await prisma.stagedChange.findMany({
        where: { environment: { projectId } },
        orderBy: { createdAt: "asc" }
    });
    return rows.map(toView);
}

/**
 * Park a change. Idempotent on the target: clicking delete twice leaves one entry
 * rather than two, and re-staging a volume with "wipe" ticked updates the parked
 * change instead of arguing with the earlier one.
 */
export async function stageChange(input: {
    environmentId: string;
    kind: StagedChangeKind;
    targetType: string;
    targetId: string;
    targetName: string;
    payload?: StagedChangePayload;
    createdById: string;
}): Promise<StagedChangeView> {
    const payload = JSON.stringify(input.payload ?? {});
    const row = await prisma.stagedChange.upsert({
        where: {
            targetType_targetId_kind: {
                targetType: input.targetType,
                targetId: input.targetId,
                kind: input.kind
            }
        },
        create: {
            environmentId: input.environmentId,
            kind: input.kind,
            targetType: input.targetType,
            targetId: input.targetId,
            targetName: input.targetName,
            payload,
            createdById: input.createdById
        },
        update: { payload, targetName: input.targetName }
    });
    return toView(row);
}

/** Take a change back out of the changeset. Scoped to the environment so an id
 *  from elsewhere cannot discard somebody else's pending work. */
export async function discardStagedChange(id: string, environmentId: string): Promise<void> {
    await prisma.stagedChange.deleteMany({ where: { id, environmentId } });
}

export async function discardAllStagedChanges(environmentId: string): Promise<void> {
    await prisma.stagedChange.deleteMany({ where: { environmentId } });
}

/** Carry out one parked change against the real infrastructure. */
async function applyOne(change: StagedChangeView, ownerId: string): Promise<void> {
    if (change.kind === "service.delete") {
        await deleteApplication(change.targetId, ownerId);
        return;
    }
    if (change.kind === "database.delete") {
        await deleteDatabase(change.targetId, ownerId);
        return;
    }
    if (change.kind === "volume.delete") {
        await deleteVolume(change.targetId, ownerId, { wipe: change.payload.wipe === true });
        return;
    }
    throw new Error(`Unsupported staged change: ${change.kind}`);
}

/**
 * Deploy the changeset. Each change is applied on its own and dropped only once
 * it has actually been carried out, so a run that fails halfway leaves exactly
 * the work that did not happen still staged - re-pressing deploy retries that and
 * nothing else.
 */
export async function applyStagedChanges(environmentId: string, ownerId: string): Promise<ApplyResult> {
    const changes = await listStagedChanges(environmentId);
    const failures: ApplyResult["failures"] = [];
    let applied = 0;

    // Volumes first: a service delete takes its volumes with it, and a volume
    // change left behind would then be a parked edit to something that no longer
    // exists. Doing them in this order makes the two independent.
    const ordered = [...changes].sort((left, right) => rank(left.kind) - rank(right.kind));

    for (const change of ordered) {
        try {
            await applyOne(change, ownerId);
            await prisma.stagedChange.deleteMany({ where: { id: change.id } });
            applied += 1;
        } catch (caught) {
            failures.push({
                targetName: change.targetName,
                error: caught instanceof Error ? caught.message : "Could not apply the change"
            });
        }
    }

    // A volume that was staged on a service that has just been deleted is not a
    // failure - the delete already took it. Clear those rather than reporting a
    // change nobody can retry.
    await prunePhantomChanges(environmentId);
    return { applied, failures };
}

function rank(kind: StagedChangeKind): number {
    return kind === "volume.delete" ? 0 : 1;
}

/** Drop staged changes whose target no longer exists, whatever removed it. */
export async function prunePhantomChanges(environmentId: string): Promise<void> {
    const rows = await prisma.stagedChange.findMany({
        where: { environmentId },
        select: { id: true, targetType: true, targetId: true }
    });
    for (const row of rows) {
        const exists =
            row.targetType === "application"
                ? await prisma.application.findUnique({ where: { id: row.targetId }, select: { id: true } })
                : row.targetType === "database"
                  ? await prisma.managedDatabase.findUnique({ where: { id: row.targetId }, select: { id: true } })
                  : await prisma.volume.findUnique({ where: { id: row.targetId }, select: { id: true } });
        if (!exists) await prisma.stagedChange.deleteMany({ where: { id: row.id } });
    }
}
