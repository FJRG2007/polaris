/**
 * Site imports, run after the upload has been answered.
 *
 * The route stages the backup and calls `startCpanelImport`, which writes the
 * row first and then runs the import in this process without holding the
 * request. The row is what the projects screen watches: its step while it runs,
 * and what came over (or the reason it did not) once it ends, so closing the
 * dialog or the tab loses nothing. One import at a time per person: two backups
 * unpacking at once is twice the scratch disk for no gain.
 *
 * A row left running by a process that restarted mid-import is reported as
 * interrupted once it has not moved for `STALE_MS`; nothing polls for it.
 */

import { prisma } from "@polaris/db";
import { rm } from "node:fs/promises";
import { BackupRefusal } from "./cpanel";
import { recordDeployAudit } from "@/lib/deploy-audit";
import { importCpanelBackup, type CpanelImportResult, type ImportStep } from "./import";

/** How long a running import may go without a step before it counts as cut short.
 *  A step is one database load or one site, and a large dump can take hours. */
const STALE_MS = 6 * 3_600_000;

/** How far back the projects screen looks for imports to show. */
const RECENT_MS = 24 * 3_600_000;

export class ImportBusy extends Error {}

export interface ImportView {
    readonly id: string;
    readonly status: "running" | "succeeded" | "failed";
    readonly step: ImportStep;
    readonly done: number;
    readonly total: number;
    readonly projectId: string | null;
    readonly result: CpanelImportResult | null;
    /** A refusal worded for the reader, or null for the generic sentence. */
    readonly error: string | null;
    readonly startedAt: string;
}

const VIEW = {
    id: true,
    status: true,
    step: true,
    done: true,
    total: true,
    projectId: true,
    result: true,
    error: true,
    startedAt: true,
    updatedAt: true
} as const;

interface Row {
    readonly id: string;
    readonly status: string;
    readonly step: string;
    readonly done: number;
    readonly total: number;
    readonly projectId: string | null;
    readonly result: unknown;
    readonly error: string | null;
    readonly startedAt: Date;
    readonly updatedAt: Date;
}

function viewOf(row: Row, now = Date.now()): ImportView {
    const stale = row.status === "running" && now - row.updatedAt.getTime() > STALE_MS;
    return {
        id: row.id,
        status: stale ? "failed" : (row.status as ImportView["status"]),
        step: row.step as ImportStep,
        done: row.done,
        total: row.total,
        projectId: row.projectId,
        result: (row.result as CpanelImportResult | null) ?? null,
        error: stale ? null : row.error,
        startedAt: row.startedAt.toISOString()
    };
}

/** One import of this person's. */
export async function getImport(id: string, ownerId: string): Promise<ImportView | null> {
    const row = await prisma.deployImport.findFirst({ where: { id, ownerId }, select: VIEW });
    return row ? viewOf(row) : null;
}

/** This person's imports of the last day, newest first. */
export async function recentImports(ownerId: string): Promise<ImportView[]> {
    const rows = await prisma.deployImport.findMany({
        where: { ownerId, startedAt: { gte: new Date(Date.now() - RECENT_MS) } },
        orderBy: { startedAt: "desc" },
        take: 5,
        select: VIEW
    });
    return rows.map((row) => viewOf(row));
}

export interface StartImportInput {
    /** The staged `.tar.gz`. Owned by the import from here on, and removed when it ends. */
    readonly archive: string;
    readonly ownerId: string;
    readonly orgId: string | null;
    readonly actorId: string;
}

/** Record the import and start it. Answers its id; refuses while another runs. */
export async function startCpanelImport(input: StartImportInput): Promise<string> {
    const running = await prisma.deployImport.findFirst({
        where: { ownerId: input.ownerId, status: "running", updatedAt: { gte: new Date(Date.now() - STALE_MS) } },
        select: { id: true }
    });
    if (running) throw new ImportBusy();
    const row = await prisma.deployImport.create({
        data: { ownerId: input.ownerId, orgId: input.orgId, actorId: input.actorId, source: "cpanel" },
        select: { id: true }
    });
    void runImport(row.id, input);
    return row.id;
}

async function runImport(id: string, input: StartImportInput): Promise<void> {
    const update = (data: Parameters<typeof prisma.deployImport.update>[0]["data"]) =>
        prisma.deployImport.update({ where: { id }, data }).catch((error: unknown) => {
            console.error(`panel-import: could not record the progress of import ${id}:`, error);
        });
    try {
        const result = await importCpanelBackup(input, async (step, done, total) => {
            await update({ step, done, total });
        });
        await update({
            status: "succeeded",
            step: "finishing",
            projectId: result.projectId,
            result: { ...result },
            finishedAt: new Date()
        });
        await recordDeployAudit({
            actorId: input.actorId,
            orgId: input.orgId ?? undefined,
            action: "deploy.project.import",
            targetType: "project",
            targetId: result.projectId,
            metadata: { services: result.services, databases: result.databases, domains: result.domains.length }
        }).catch((error: unknown) => console.error("panel-import: the import was not audited:", error));
    } catch (error) {
        // Worded for the sender; anything else names internals, so it stays in the log.
        const refusal = error instanceof BackupRefusal ? error.message : null;
        if (!refusal) console.error(`panel-import: import ${id} failed:`, error);
        await update({ status: "failed", error: refusal, finishedAt: new Date() });
    } finally {
        await rm(input.archive, { force: true });
    }
}
