/**
 * Moving the CRM workflows to the central automations engine: a data step,
 * never a migration, run every minute until nothing is left, so an install
 * moves after its next Update with nobody doing anything.
 *
 * Idempotent. The central twin is keyed by `legacyRef` ("crm-workflow:<id>"),
 * unique, so a pass that crashed after creating it finds it again and only
 * marks the row. Nothing is deleted: the old row keeps its definition, its
 * versions and its runs (still read by the run history), its runs already
 * waiting finish on the old engine, and from the moment `movedToId` is set the
 * old engine starts nothing new for it - its webhook address and "Run on this
 * record" start the automation instead. A row this build cannot convert, or
 * one nobody runs as, is left where it is, running as before.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { convertWorkflow, LEGACY_PREFIX } from "../model/automation-nodes";

/** Rows per pass: a pass is a few queries each, and the next tick takes the rest. */
const BATCH = 25;

/** Rows that could not be converted, said once per process rather than every minute. */
const reported = new Set<string>();

/** Where the next pass reads from: past the rows that stayed, so they never hold back newer ones. */
let after: { readonly createdAt: Date; readonly id: string } | null = null;

const MOVABLE = {
    id: true,
    orgId: true,
    object: true,
    name: true,
    trigger: true,
    actions: true,
    enabled: true,
    runAsId: true,
    createdAt: true
} as const;

interface MovableRow {
    readonly id: string;
    readonly orgId: string | null;
    readonly object: string;
    readonly name: string;
    readonly trigger: string;
    readonly actions: string;
    readonly enabled: boolean;
    readonly runAsId: string | null;
}

function report(id: string, why: string): void {
    if (reported.has(id)) return;
    reported.add(id);
    console.error(`crm: workflow ${id} stays on the CRM engine: ${why}`);
}

/** Move one row; the central id, or null when it stays here (said in the log). */
async function moveRow(row: MovableRow): Promise<string | null> {
    if (!row.runAsId) {
        report(row.id, "nobody runs it");
        return null;
    }
    const converted = convertWorkflow(row);
    if (!converted.ok) {
        report(row.id, `it could not be converted (${converted.reason})`);
        return null;
    }
    try {
        const centralId = await host.automations.importLegacyAutomation({
            legacyRef: `${LEGACY_PREFIX}${row.id}`,
            name: row.name,
            enabled: row.enabled,
            ownerId: row.runAsId,
            origin: "crm",
            originRef: row.object,
            // What a workflow always did: a change while a run is going starts beside it.
            mode: "parallel",
            graph: converted.graph
        });
        // Its schedule is the automation's now: the old engine never claims it again.
        await prisma.crmWorkflow.updateMany({
            where: { id: row.id, movedToId: null },
            data: { movedToId: centralId, nextRunAt: null }
        });
        return centralId;
    } catch (error) {
        console.error(`crm: workflow ${row.id} could not be moved yet:`, error);
        return null;
    }
}

/** Move the next few. Returns how many moved. */
export async function moveCrmWorkflows(): Promise<number> {
    const from = after;
    const rows = await prisma.crmWorkflow.findMany({
        where: {
            movedToId: null,
            ...(from
                ? {
                      OR: [
                          { createdAt: { gt: from.createdAt } },
                          { createdAt: from.createdAt, id: { gt: from.id } }
                      ]
                  }
                : {})
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: BATCH,
        select: MOVABLE
    });
    const last = rows.at(-1);
    after = rows.length === BATCH && last ? { createdAt: last.createdAt, id: last.id } : null;
    let moved = 0;
    for (const row of rows) if (await moveRow(row)) moved += 1;
    return moved;
}

/** Old runs shown, newest first: the history screen is a glance, not an archive. */
const HISTORY = 50;

/** The runs a moved workflow had here before the move, read-only. */
export async function legacyRuns(
    legacyRef: string
): Promise<{ id: string; status: string; startedAt: string; finishedAt: string | null }[]> {
    if (!legacyRef.startsWith(LEGACY_PREFIX)) return [];
    const rows = await prisma.crmWorkflowRun.findMany({
        where: { workflowId: legacyRef.slice(LEGACY_PREFIX.length) },
        orderBy: { startedAt: "desc" },
        take: HISTORY,
        select: { id: true, status: true, startedAt: true, finishedAt: true }
    });
    return rows.map((row) => ({
        id: row.id,
        status: row.status,
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null
    }));
}
