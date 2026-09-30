/**
 * A place's automations: listing them, saving them, switching them on and off,
 * and the log of what each one did.
 *
 * Running them is the engine's (`automation-engine.ts`); this is the half a
 * screen talks to. Every automation belongs to one place and one install, and
 * every lookup here is by both, so an id from another install answers "not
 * here" rather than somebody else's automation.
 *
 * Server-only.
 */

import { z } from "zod";
import { getPlace } from "./places";
import { prisma } from "@polaris/db";
import { listDevices } from "./devices";
import { HomeError } from "./home-error";
import * as auto from "./automation-kinds";
import { automationEngine } from "./automation-runtime";
import { json, toAutomation, toRun } from "./automation-store";

const FIELDS = {
    id: true,
    installedAppId: true,
    placeId: true,
    ownerId: true,
    name: true,
    enabled: true,
    definition: true,
    armedAt: true,
    lastRunAt: true,
    lastStatus: true,
    updatedAt: true
} as const;

type Row = {
    id: string;
    installedAppId: string;
    placeId: string;
    ownerId: string;
    name: string;
    enabled: boolean;
    definition: unknown;
    armedAt: Date;
    lastRunAt: Date | null;
    lastStatus: string | null;
    updatedAt: Date;
};

async function ownerNames(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const users = await prisma.user.findMany({
        where: { id: { in: [...new Set(ids)] } },
        select: { id: true, name: true }
    });
    return new Map(users.map((user) => [user.id, user.name ?? ""]));
}

function toView(row: Row, owners: ReadonlyMap<string, string>): auto.AutomationView | null {
    const record = toAutomation(row);
    if (!record) return null;
    return {
        id: row.id,
        placeId: row.placeId,
        name: row.name,
        enabled: row.enabled,
        ownerName: owners.get(row.ownerId) ?? "",
        definition: record.definition,
        lastRunAt: row.lastRunAt?.toISOString() ?? null,
        lastStatus: auto.runStatus(row.lastStatus),
        updatedAt: row.updatedAt.toISOString()
    };
}

const idSchema = z.string().uuid();

async function requireAutomation(installedAppId: string, id: string): Promise<Row> {
    if (!idSchema.safeParse(id).success) throw new HomeError("That automation is not here");
    const row = await prisma.placeAutomation.findFirst({ where: { id, installedAppId }, select: FIELDS });
    if (!row) throw new HomeError("That automation is not here");
    return row;
}

/** The automations of one place, oldest first: the order they were written in
 *  is the order somebody remembers them in. */
export async function listAutomations(installedAppId: string, placeId: string): Promise<auto.AutomationView[]> {
    const rows = await prisma.placeAutomation.findMany({
        where: { installedAppId, placeId },
        orderBy: { createdAt: "asc" },
        select: FIELDS
    });
    const owners = await ownerNames(rows.map((row) => row.ownerId));
    return rows.flatMap((row) => toView(row, owners) ?? []);
}

export async function getAutomation(installedAppId: string, id: string): Promise<auto.AutomationView> {
    const row = await requireAutomation(installedAppId, id);
    const view = toView(row, await ownerNames([row.ownerId]));
    if (!view) throw new HomeError("That automation was saved by a newer Polaris");
    return view;
}

/**
 * What is wrong with an automation that the schema cannot see: devices that are
 * not at its place, steps a device cannot do, a step that runs an automation
 * that is gone. The same function the editor runs, on what the server has.
 */
export async function checkAutomation(
    installedAppId: string,
    input: auto.AutomationInput,
    selfId: string | null
): Promise<auto.AutomationIssue[]> {
    const place = await getPlace(installedAppId, input.placeId);
    if (!place) return [{ path: ["placeId"], message: "automations.errors.place" }];
    const [devices, others] = await Promise.all([
        listDevices(installedAppId, input.placeId),
        prisma.placeAutomation.findMany({
            where: { installedAppId, placeId: input.placeId },
            select: { id: true }
        })
    ]);
    return auto.deviceIssues(input.definition, devices, {
        automationIds: others.map((other) => other.id),
        selfId
    });
}

/**
 * Write an automation, new or changed.
 *
 * Whoever saves it becomes who it acts as: they are the one who looked at every
 * step and put their name to it. It is armed from now - a time of day that has
 * already passed today is not one it missed.
 */
export async function saveAutomation(
    installedAppId: string,
    ownerId: string,
    id: string | null,
    input: auto.AutomationInput
): Promise<auto.AutomationView> {
    const before = id ? toAutomation(await requireAutomation(installedAppId, id)) : null;
    const issues = await checkAutomation(installedAppId, input, id);
    if (issues.length > 0) throw new HomeError("That automation names something that is not here");
    const data = {
        placeId: input.placeId,
        ownerId,
        name: input.name,
        enabled: input.enabled,
        definition: json(input.definition),
        armedAt: new Date()
    };
    const row = id
        ? await prisma.placeAutomation.update({ where: { id }, data, select: FIELDS })
        : await prisma.placeAutomation.create({ data: { ...data, installedAppId }, select: FIELDS });
    if (!input.enabled) await stopPending(row.id, ["queued", "waiting", "running"], "disabled");
    else if (id && !sameSteps(before?.definition.actions, input.definition.actions)) {
        await stopPending(row.id, ["waiting", "running"], "edited");
    }
    const view = toView(row, await ownerNames([row.ownerId]));
    if (!view) throw new HomeError("That automation was saved by a newer Polaris");
    return view;
}

/** Switch one on or off. Off also ends whatever it was in the middle of: a delay
 *  counting down to "turn the heating off" is not something a switched-off
 *  automation should still do. */
export async function setAutomationEnabled(
    installedAppId: string,
    id: string,
    enabled: boolean
): Promise<auto.AutomationView> {
    await requireAutomation(installedAppId, id);
    const row = await prisma.placeAutomation.update({
        where: { id },
        data: enabled ? { enabled, armedAt: new Date() } : { enabled },
        select: FIELDS
    });
    if (!enabled) await stopPending(id, ["queued", "waiting", "running"], "disabled");
    const view = toView(row, await ownerNames([row.ownerId]));
    if (!view) throw new HomeError("That automation was saved by a newer Polaris");
    return view;
}

function sameSteps(
    before: readonly auto.Step[] | undefined,
    after: readonly auto.Step[]
): boolean {
    return before !== undefined && JSON.stringify(before) === JSON.stringify(after);
}

async function stopPending(
    automationId: string,
    statuses: readonly auto.RunStatus[],
    reason: "disabled" | "edited"
): Promise<void> {
    await prisma.placeAutomationRun.updateMany({
        where: { automationId, status: { in: [...statuses] } },
        data: {
            status: "stopped",
            reason,
            dueAt: null,
            waitUntil: null,
            waitDeviceId: null,
            finishedAt: new Date()
        }
    });
}

export async function deleteAutomation(installedAppId: string, id: string): Promise<void> {
    await requireAutomation(installedAppId, id);
    await prisma.placeAutomation.delete({ where: { id } });
}

/** Run it now, whatever its triggers say. Its conditions still apply: Run now is
 *  "do what you would do", not "skip the checks". */
export async function runAutomationNow(
    installedAppId: string,
    id: string,
    byUser: string,
    pressId: string
): Promise<void> {
    const row = await requireAutomation(installedAppId, id);
    const record = toAutomation(row);
    if (!record) throw new HomeError("That automation was saved by a newer Polaris");
    const engine = automationEngine();
    await engine.runNow(record, byUser, pressId);
    // Not awaited: the first steps may take a few seconds at a slow account, and
    // the screen asks for the log again rather than holding the button down.
    void engine.drain().catch((error) => console.error("places: an automation could not run:", error));
}

/** What an automation has done, newest first. */
export async function listRuns(installedAppId: string, automationId: string, limit = 50): Promise<auto.RunView[]> {
    await requireAutomation(installedAppId, automationId);
    const rows = await prisma.placeAutomationRun.findMany({
        where: { automationId },
        orderBy: { startedAt: "desc" },
        take: Math.max(1, Math.min(100, limit)),
        select: {
            id: true,
            automationId: true,
            firingKey: true,
            cause: true,
            depth: true,
            status: true,
            step: true,
            dueAt: true,
            waitUntil: true,
            waitDeviceId: true,
            lockedUntil: true,
            steps: true,
            reason: true,
            startedAt: true,
            finishedAt: true
        }
    });
    return rows.map((row) => {
        const run = toRun(row);
        return {
            id: run.id,
            automationId: run.automationId,
            status: run.status,
            cause: run.cause,
            steps: run.steps,
            reason: run.reason,
            startedAt: run.startedAt.toISOString(),
            finishedAt: run.finishedAt?.toISOString() ?? null,
            dueAt: run.dueAt?.toISOString() ?? null
        };
    });
}
