/**
 * Moving the Places automations to the central engine: a data step, never a
 * migration, run on every boot and every minute tick until nothing is left, so
 * an install moves after its next Update with nobody doing anything.
 *
 * Idempotent. The central twin is keyed by `legacyRef` ("place:<id>"), unique,
 * so a pass that crashed after creating it finds it again and only marks the
 * row. Nothing is deleted: the old row keeps its definition and its runs (still
 * read by the run history), its runs already waiting finish on the old engine,
 * and from the moment `movedToId` is set the old engine starts nothing new for
 * it. A row this build cannot convert is left where it is, running as before.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { convertPlaceAutomation } from "./automation-convert";
import { LEGACY_PREFIX } from "./automation-central";

/** Rows per pass: a pass is a few queries each, and the next tick takes the rest. */
const BATCH = 25;

/** Rows that could not be converted, said once per process rather than every minute. */
const reported = new Set<string>();

/** Where the next pass reads from: past the rows that stayed, so they never hold
 *  back newer ones. Back to the start once a pass reaches the end. */
let after: { readonly createdAt: Date; readonly id: string } | null = null;

interface MovableRow {
    readonly id: string;
    readonly placeId: string;
    readonly ownerId: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly definition: unknown;
}

const MOVABLE = {
    id: true,
    placeId: true,
    ownerId: true,
    name: true,
    enabled: true,
    definition: true
} as const;

/** Move one row; the central id, or null when it stays here (said in the log). */
async function moveRow(row: MovableRow): Promise<string | null> {
    const converted = convertPlaceAutomation(row);
    if (!converted.ok) {
        if (!reported.has(row.id)) {
            reported.add(row.id);
            console.error(
                `places: automation ${row.id} stays on the Places engine: it could not be converted (${converted.reason})`
            );
        }
        return null;
    }
    try {
        const centralId = await host.automations.importLegacyAutomation({
            legacyRef: `${LEGACY_PREFIX}${row.id}`,
            name: row.name,
            enabled: row.enabled,
            ownerId: row.ownerId,
            origin: "home",
            originRef: row.placeId,
            // What Places always did: a firing while a run is going starts beside it.
            mode: "parallel",
            graph: converted.graph
        });
        await prisma.placeAutomation.updateMany({
            where: { id: row.id, movedToId: null },
            data: { movedToId: centralId }
        });
        return centralId;
    } catch (error) {
        console.error(`places: automation ${row.id} could not be moved yet:`, error);
        return null;
    }
}

/** Move the next few. Returns how many moved. */
export async function movePlaceAutomations(): Promise<number> {
    const from = after;
    const rows = await prisma.placeAutomation.findMany({
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
        select: { ...MOVABLE, createdAt: true }
    });
    const last = rows.at(-1);
    after = rows.length === BATCH && last ? { createdAt: last.createdAt, id: last.id } : null;
    let moved = 0;
    for (const row of rows) if (await moveRow(row)) moved += 1;
    return moved;
}

/**
 * Move one row now - one just written from this app's screen, so the person who
 * made it lands on the automation it is, rather than on one the next tick moves.
 * The central id, or null when it stays here (the tick tries again).
 */
export async function moveAutomationNow(id: string): Promise<string | null> {
    const row = await prisma.placeAutomation.findUnique({
        where: { id },
        select: { ...MOVABLE, movedToId: true }
    });
    if (!row) return null;
    return row.movedToId ?? moveRow(row);
}

/** Where an old automation's screen went: its central twin, or null while it has none. */
export async function movedTo(id: string): Promise<string | null> {
    const row = await prisma.placeAutomation.findUnique({
        where: { id },
        select: { movedToId: true }
    });
    if (row?.movedToId) return row.movedToId;
    return host.automations.automationForLegacy(`${LEGACY_PREFIX}${id}`);
}

/** Old runs shown, newest first: the history screen is a glance, not an archive. */
const HISTORY = 50;

/** The runs a moved automation had here before the move, read-only. */
export async function legacyRuns(legacyRef: string): Promise<
    { id: string; status: string; startedAt: string; finishedAt: string | null }[]
> {
    if (!legacyRef.startsWith(LEGACY_PREFIX)) return [];
    const rows = await prisma.placeAutomationRun.findMany({
        where: { automationId: legacyRef.slice(LEGACY_PREFIX.length) },
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
