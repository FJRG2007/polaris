/**
 * PostgreSQL point-in-time recovery, with PostgreSQL's own tools.
 *
 * The instance archives every completed write-ahead log segment into a folder
 * on its server (`archive_command`, see `pitrServerCommand`), and a base backup
 * is taken into the same folder once a day with `pg_basebackup`. A base backup
 * plus every segment archived after it is enough to rebuild the instance as it
 * was at any moment since that backup finished - which is the whole of the
 * mechanism, as the manual's "Continuous Archiving and Point-in-Time Recovery"
 * chapter describes it.
 *
 * A recovery never touches the instance it recovers: it lands in a NEW instance
 * on the same server, which mounts the archive, unpacks the chosen base backup
 * and replays the log up to the moment asked for. Whoever asked can then point
 * services at it, copy data out of it, or delete it.
 *
 * What this does not do: the archive lives on the server's own disk, beside the
 * instance. It protects against a bad migration, a dropped table, a mistaken
 * DELETE - not against losing the disk. The instance's ordinary backups are what
 * travel off the machine.
 */

import { prisma } from "@polaris/db";
import { shortHash, slugify } from "@polaris/deploy";
import { deployDatabase, deployDatabaseAndWait } from "@/lib/database-service";
import {
    DatabaseOperationError,
    instanceContext,
    lastLine,
    runStep,
    startOperation,
    waitReady,
    withPorts,
    type InstanceContext
} from "./ops";
import {
    pitrBaseBackupCommand,
    pitrBaseFor,
    pitrCleanupCommands,
    pitrLabel,
    pitrNewestHistoryCommand,
    pitrPrepareCommand,
    PITR_KEEP_DAYS,
    PITR_MOUNT
} from "@polaris/core";

const DAY = 24 * 3_600_000;

/** A dedicated PostgreSQL instance the owner holds. */
async function pitrInstance(databaseId: string, ownerId: string) {
    const row = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId } } },
        select: {
            id: true,
            engine: true,
            parentId: true,
            pitr: true,
            pitrKeepDays: true,
            status: true,
            name: true
        }
    });
    if (!row) throw new DatabaseOperationError("That database is not there any more.");
    if (row.engine !== "postgres")
        throw new DatabaseOperationError("Point-in-time recovery is for PostgreSQL.");
    if (row.parentId) {
        throw new DatabaseOperationError(
            "This database lives inside another instance; turn point-in-time recovery on for that instance."
        );
    }
    return row;
}

/**
 * Turn archiving on or off, or change how many days are kept. Turning it on or
 * off changes the command the server runs with, so the instance is deployed
 * again; turning it off also removes the archive, which is what makes the
 * recovery window end.
 */
export async function setPitr(
    databaseId: string,
    ownerId: string,
    userId: string,
    input: { enabled: boolean; keepDays: number }
): Promise<{ deploymentId: string | null }> {
    const row = await pitrInstance(databaseId, ownerId);
    if (!(PITR_KEEP_DAYS as readonly number[]).includes(input.keepDays)) {
        throw new DatabaseOperationError("Pick one of the offered windows.");
    }
    if (row.pitr === input.enabled) {
        await prisma.managedDatabase.update({
            where: { id: row.id },
            data: { pitrKeepDays: input.keepDays }
        });
        return { deploymentId: null };
    }
    if (!input.enabled) {
        // The archive is emptied while the archiving container is still the one
        // that mounts it.
        const context = await instanceContext(row.id, ownerId).catch(() => null);
        if (context) {
            await withPorts(context, (ports) =>
                ports.runIn(context.container, [
                    "sh",
                    "-c",
                    'rm -rf "$1/wal" "$1/base"',
                    "polaris",
                    PITR_MOUNT
                ])
            ).catch(() => undefined);
        }
        await prisma.databaseBaseBackup.deleteMany({ where: { databaseId: row.id } });
    }
    await prisma.managedDatabase.update({
        where: { id: row.id },
        data: { pitr: input.enabled, pitrKeepDays: input.keepDays }
    });
    return { deploymentId: await deployDatabase(row.id, ownerId, userId) };
}

/**
 * Make the archive folders exist and belong to the server, and take the first
 * base backup when there is none - until one exists there is nothing to
 * recover from.
 */
export async function preparePitr(
    databaseId: string,
    ownerId: string,
    options: { baseBackup: boolean }
): Promise<void> {
    const context = await instanceContext(databaseId, ownerId);
    await withPorts(context, async (ports) => {
        await waitReady(ports, context);
        await runStep(ports, context.container, pitrPrepareCommand());
    });
    if (!options.baseBackup) return;
    const existing = await prisma.databaseBaseBackup.count({ where: { databaseId } });
    if (existing === 0) await takeBaseBackup(context);
}

/** Take one base backup into the archive and record it. */
export async function takeBaseBackup(context: InstanceContext): Promise<void> {
    const startedAt = new Date();
    const label = pitrLabel(startedAt);
    await withPorts(context, async (ports) => {
        await runStep(ports, context.container, pitrPrepareCommand());
        await runStep(
            ports,
            context.container,
            pitrBaseBackupCommand(label, context.own.username),
            [context.own.password]
        );
        const history = await runStep(ports, context.container, pitrNewestHistoryCommand());
        await prisma.databaseBaseBackup.create({
            data: {
                databaseId: context.id,
                label,
                startedAt,
                finishedAt: new Date(),
                historyFile: lastLine(history)
            }
        });
    });
}

/**
 * What can be recovered: from when the oldest kept base backup finished to the
 * last segment archived, which is at most a minute behind (`archive_timeout`).
 */
export async function pitrWindow(databaseId: string, ownerId: string) {
    const row = await pitrInstance(databaseId, ownerId);
    const bases = await prisma.databaseBaseBackup.findMany({
        where: { databaseId },
        orderBy: { finishedAt: "asc" },
        select: { label: true, finishedAt: true }
    });
    return {
        enabled: row.pitr,
        keepDays: row.pitrKeepDays,
        from: bases[0]?.finishedAt.toISOString() ?? null,
        baseBackups: bases.map((base) => ({
            label: base.label,
            finishedAt: base.finishedAt.toISOString()
        }))
    };
}

/**
 * The daily pass: a base backup for every archiving instance whose newest one
 * is a day old, then everything older than its window removed.
 *
 * Retention keeps every base backup that finished inside the window AND the
 * newest one before it, since a moment at the start of the window can only be
 * reached from a backup that finished before that moment. Segments older than
 * the oldest kept backup are then removed by `pg_archivecleanup`, which is what
 * the manual gives that job to.
 */
export async function sweepArchives(): Promise<{
    instances: number;
    backups: number;
    failed: number;
}> {
    const rows = await prisma.managedDatabase.findMany({
        where: {
            engine: "postgres",
            pitr: true,
            parentId: null,
            status: "running",
            upgradeState: { not: "running" }
        },
        select: {
            id: true,
            pitrKeepDays: true,
            environment: { select: { project: { select: { ownerId: true } } } }
        }
    });
    let backups = 0;
    let failed = 0;
    for (const row of rows) {
        try {
            const context = await instanceContext(row.id, row.environment.project.ownerId);
            const newest = await prisma.databaseBaseBackup.findFirst({
                where: { databaseId: row.id },
                orderBy: { finishedAt: "desc" },
                select: { finishedAt: true }
            });
            if (!newest || Date.now() - newest.finishedAt.getTime() >= DAY - 10 * 60_000) {
                await takeBaseBackup(context);
                backups += 1;
            }
            await pruneArchive(context, row.pitrKeepDays);
        } catch (error) {
            failed += 1;
            const reason =
                error instanceof DatabaseOperationError
                    ? error.message
                    : "The archive pass failed.";
            if (!(error instanceof DatabaseOperationError))
                console.error(`database: archive pass on ${row.id} failed:`, error);
            await prisma.databaseOperation.create({
                data: {
                    databaseId: row.id,
                    kind: "archive",
                    status: "failed",
                    step: "Daily base backup",
                    error: reason,
                    finishedAt: new Date()
                }
            });
        }
    }
    return { instances: rows.length, backups, failed };
}

async function pruneArchive(context: InstanceContext, keepDays: number): Promise<void> {
    const bases = await prisma.databaseBaseBackup.findMany({
        where: { databaseId: context.id },
        orderBy: { finishedAt: "desc" }
    });
    const windowStart = Date.now() - keepDays * DAY;
    const inside = bases.filter((base) => base.finishedAt.getTime() >= windowStart);
    const before = bases.find((base) => base.finishedAt.getTime() < windowStart);
    const kept = new Set([...inside, ...(before ? [before] : [])].map((base) => base.id));
    const removed = bases.filter((base) => !kept.has(base.id));
    const oldestKept = bases.filter((base) => kept.has(base.id)).at(-1);
    if (removed.length === 0 || !oldestKept?.historyFile) return;
    await withPorts(context, async (ports) => {
        for (const command of pitrCleanupCommands(
            oldestKept.historyFile,
            removed.map((base) => base.label)
        )) {
            await runStep(ports, context.container, command);
        }
    });
    await prisma.databaseBaseBackup.deleteMany({
        where: { id: { in: removed.map((base) => base.id) } }
    });
}

/**
 * Start again after a major upgrade: segments and base backups written by the
 * previous version cannot be replayed by the new one, so they go, and a first
 * base backup of the upgraded instance opens a new window.
 */
export async function restartArchive(databaseId: string, ownerId: string): Promise<void> {
    const context = await instanceContext(databaseId, ownerId);
    await withPorts(context, async (ports) => {
        await waitReady(ports, context);
        await runStep(ports, context.container, {
            argv: ["sh", "-c", 'rm -rf "$1/wal" "$1/base"', "polaris", PITR_MOUNT],
            describe: "Removing the previous version's archive"
        });
        await runStep(ports, context.container, pitrPrepareCommand());
    });
    await prisma.databaseBaseBackup.deleteMany({ where: { databaseId } });
    await takeBaseBackup(context);
}

/** How long a recovered instance is given to replay the archive to its target. */
const REPLAY_WAIT_MS = 2 * 3_600_000;

/**
 * Recover an archiving instance to a moment, into a new instance beside it.
 *
 * Returns the new instance's id at once; the recovery itself runs on and is
 * followed on the new instance's operations.
 */
export async function recoverToTime(
    databaseId: string,
    ownerId: string,
    userId: string,
    input: { target: Date; name: string }
): Promise<{ databaseId: string }> {
    const source = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId } } }
    });
    if (!source) throw new DatabaseOperationError("That database is not there any more.");
    await pitrInstance(databaseId, ownerId);
    if (!source.pitr)
        throw new DatabaseOperationError("Point-in-time recovery is not on for this instance.");
    if (source.status !== "running") {
        throw new DatabaseOperationError(
            "The instance has to be running: the last minute of its log is still inside it."
        );
    }
    const target = input.target;
    if (target.getTime() > Date.now())
        throw new DatabaseOperationError("That moment has not happened yet.");
    const bases = await prisma.databaseBaseBackup.findMany({ where: { databaseId } });
    const base = pitrBaseFor(bases, target);
    if (!base) {
        const oldest = [...bases].sort(
            (a, b) => a.finishedAt.getTime() - b.finishedAt.getTime()
        )[0];
        throw new DatabaseOperationError(
            oldest
                ? `The archive reaches back to ${oldest.finishedAt.toISOString()}; pick a moment after that.`
                : "There is no base backup yet to recover from."
        );
    }
    const slug = slugify(input.name);
    if (!slug) throw new DatabaseOperationError("The name has to contain letters or digits.");
    const clash = await prisma.managedDatabase.findFirst({
        where: { environmentId: source.environmentId, slug },
        select: { name: true }
    });
    if (clash)
        throw new DatabaseOperationError(
            `This environment already has a database called ${clash.name}.`
        );

    // The recovered instance starts from the source's own files, so it keeps the
    // source's accounts: its stored credentials are the source's, copied.
    const created = await prisma.managedDatabase.create({
        data: {
            environmentId: source.environmentId,
            targetId: source.targetId,
            name: input.name,
            slug,
            engine: source.engine,
            image: source.image,
            version: source.version,
            volumeName: `postgres-data-${shortHash(`${source.id}-${base.label}-${target.toISOString()}`, 8)}`,
            containerName: "",
            privileges: source.privileges,
            encryptedCredential: source.encryptedCredential,
            credentialNonce: source.credentialNonce,
            credentialKeyId: source.credentialKeyId,
            recoveredFromId: source.id,
            recoveryBase: base.label,
            recoveryTarget: target
        },
        select: { id: true }
    });
    const operation = await startOperation(created.id, "recover", userId);
    void (async () => {
        try {
            await operation.step("Closing the log up to now");
            await sealArchive(await instanceContext(source.id, ownerId));
            await operation.step(
                `Starting from the base backup of ${base.finishedAt.toISOString()}`
            );
            const failure = await deployDatabaseAndWait(created.id, ownerId, userId);
            if (failure)
                throw new DatabaseOperationError(
                    `The recovered instance did not start: ${failure}`
                );
            await operation.step("Replaying the log to the moment asked for");
            await waitForPromotion(await instanceContext(created.id, ownerId));
            await operation.succeed();
        } catch (error) {
            await operation.fail(error);
            await prisma.managedDatabase
                .update({ where: { id: created.id }, data: { status: "failed" } })
                .catch(() => undefined);
        }
    })();
    return { databaseId: created.id };
}

/**
 * Make sure the archive holds everything up to now.
 *
 * A recovery to a moment stops at the first commit after it; if the archive
 * has no commit after the moment, PostgreSQL ends recovery without reaching the
 * target and refuses to start. So a transaction is committed now - `txid_current`
 * assigns it an id, which is what makes its commit a log record - the segment is
 * switched, and the wait lasts until that segment is in the archive.
 */
async function sealArchive(context: InstanceContext): Promise<void> {
    await withPorts(context, async (ports) => {
        await waitReady(ports, context);
        const psql = (sql: string) => [
            "env",
            `PGPASSWORD=${context.own.password}`,
            "psql",
            "-v",
            "ON_ERROR_STOP=1",
            "-tA",
            "-U",
            context.own.username,
            "-d",
            "postgres",
            "-c",
            sql
        ];
        await runStep(
            ports,
            context.container,
            { argv: psql("SELECT txid_current()"), describe: "Committing a marker" },
            [context.own.password]
        );
        const switched = await runStep(
            ports,
            context.container,
            {
                argv: psql("SELECT pg_walfile_name(pg_switch_wal())"),
                describe: "Closing the current log segment"
            },
            [context.own.password]
        );
        const segment = lastLine(switched);
        if (!/^[0-9A-F]{24}$/.test(segment))
            throw new DatabaseOperationError("PostgreSQL did not name the segment it closed.");
        const deadline = Date.now() + 5 * 60_000;
        while (Date.now() < deadline) {
            const found = await ports.runIn(context.container, [
                "test",
                "-f",
                `${PITR_MOUNT}/wal/${segment}`
            ]);
            if (found.code === 0) return;
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        throw new DatabaseOperationError(
            "The last log segment did not reach the archive in five minutes."
        );
    });
}

/** Wait until the recovered instance has replayed to its target and opened for
 *  writes - `pg_is_in_recovery()` turns false on promotion. */
async function waitForPromotion(context: InstanceContext): Promise<void> {
    await withPorts(context, async (ports) => {
        const deadline = Date.now() + REPLAY_WAIT_MS;
        let said = "";
        while (Date.now() < deadline) {
            const result = await ports
                .runIn(context.container, [
                    "env",
                    `PGPASSWORD=${context.own.password}`,
                    "psql",
                    "-tA",
                    "-U",
                    context.own.username,
                    "-d",
                    "postgres",
                    "-c",
                    "SELECT pg_is_in_recovery()"
                ])
                .catch(() => null);
            if (result?.code === 0 && lastLine(result.output) === "f") return;
            if (result) said = lastLine(result.output, [context.own.password]);
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }
        throw new DatabaseOperationError(
            `The recovery did not finish in two hours${said ? `: ${said}` : ""}.`
        );
    });
}
