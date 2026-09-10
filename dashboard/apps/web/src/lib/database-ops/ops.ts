/**
 * What every long operation on a managed database shares: finding the instance
 * and the container to act in, running a step and saying which one failed,
 * waiting until the engine answers, putting a file inside the container, and a
 * record of the operation that somebody can watch.
 *
 * Nothing here decides WHAT to run - the command builders in `@polaris/core`
 * (`database-maintenance`) do that, purely - only how it is run and reported.
 * A step's failure names the step and the engine's last line; it never echoes
 * the command, which carries passwords.
 */

import { prisma } from "@polaris/db";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { RuntimePorts } from "@polaris/deploy";
import { getPorts, type TargetRow } from "@/lib/deploy/runtime";
import { databaseCredentials, type DbCredentials } from "@/lib/database-service";
import {
    readinessCommand,
    isManagedEngine,
    type ManagedEngine,
    type MaintenanceCommand
} from "@polaris/core";

/** Everything an operation needs about one instance, resolved once. */
export interface InstanceContext {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly engine: ManagedEngine;
    readonly version: string;
    readonly ownerId: string;
    readonly target: TargetRow;
    /** The container to act in: the instance's own, or for a database hosted on
     *  an instance, that instance's. */
    readonly container: string;
    /** The database's own account and name. */
    readonly own: DbCredentials;
    /** The instance's administrative account - its own for a dedicated one. */
    readonly admin: DbCredentials;
    readonly hosted: boolean;
    readonly privileges: string;
}

/** Raised for a refusal whose words are meant for the screen. */
export class DatabaseOperationError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "DatabaseOperationError";
    }
}

/**
 * Resolve an instance the owner holds, with its container and both accounts.
 * Refuses one that has never been deployed: there is no container to act in.
 */
export async function instanceContext(
    databaseId: string,
    ownerId: string
): Promise<InstanceContext> {
    const row = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId } } },
        include: { target: true, parent: { select: { id: true, containerName: true } } }
    });
    if (!row) throw new DatabaseOperationError("That database is not there any more.");
    if (!isManagedEngine(row.engine)) {
        throw new DatabaseOperationError(`Polaris cannot look after a ${row.engine} instance.`);
    }
    const container = row.parent ? row.parent.containerName : row.containerName;
    if (!container)
        throw new DatabaseOperationError("Deploy this database first - it has no container yet.");
    const own = await databaseCredentials(row.id, ownerId);
    const admin = row.parent ? await databaseCredentials(row.parent.id, ownerId) : own;
    return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        engine: row.engine,
        version: row.version,
        ownerId,
        target: row.target as TargetRow,
        container,
        own,
        admin,
        hosted: row.parent !== null,
        privileges: row.privileges
    };
}

/** Open the ports to the instance's server for the length of `work`. */
export async function withPorts<T>(
    context: Pick<InstanceContext, "target" | "ownerId">,
    work: (ports: RuntimePorts) => Promise<T>
): Promise<T> {
    const ports = await getPorts(context.target, context.ownerId);
    try {
        return await work(ports);
    } finally {
        await ports.dispose().catch(() => undefined);
    }
}

/** The last meaningful line an engine printed, for an error. Bounded, and a
 *  password echoed back by a client (`-p...`) is masked out. */
export function lastLine(output: string, secrets: readonly string[] = []): string {
    let line =
        output
            .split(/\r?\n/)
            .map((entry) => entry.trim())
            .filter(Boolean)
            .at(-1) ?? "";
    for (const secret of secrets) if (secret) line = line.split(secret).join("********");
    return line.slice(0, 400);
}

/** Run one step, or throw naming it. */
export async function runStep(
    ports: RuntimePorts,
    container: string,
    command: MaintenanceCommand,
    secrets: readonly string[] = []
): Promise<string> {
    const result = await ports.runIn(container, command.argv);
    if (result.code !== 0) {
        const said = lastLine(result.output, secrets);
        throw new DatabaseOperationError(`${command.describe} failed${said ? `: ${said}` : ""}`);
    }
    return result.output;
}

/** How long an engine is given to start answering after its container starts. */
const READY_WAIT_MS = 3 * 60_000;

/**
 * Wait until the engine accepts connections. A container that is up is not a
 * database that answers - PostgreSQL and MySQL take seconds more, and a first
 * start that initialises a data folder can take a minute.
 */
export async function waitReady(ports: RuntimePorts, context: InstanceContext): Promise<void> {
    const probe = readinessCommand({
        engine: context.engine,
        username: context.admin.username,
        password: context.admin.password
    });
    const deadline = Date.now() + READY_WAIT_MS;
    let said = "";
    while (Date.now() < deadline) {
        const result = await ports.runIn(context.container, probe.argv).catch(() => null);
        if (result && result.code === 0) return;
        said = result ? lastLine(result.output, [context.admin.password]) : said;
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new DatabaseOperationError(
        `${context.name} did not start answering within ${READY_WAIT_MS / 60_000} minutes${said ? `: ${said}` : ""}`
    );
}

/**
 * Put a staged local file inside the container at `path`, and check that all
 * of it arrived - a write cut short is a restore of half a dump, and the size is
 * the one thing both sides can agree on without trusting the transport.
 */
export async function stageInto(
    ports: RuntimePorts,
    container: string,
    localPath: string,
    path: string,
    onProgress?: (done: number, total: number) => void
): Promise<void> {
    if (!ports.writeFile) {
        throw new DatabaseOperationError(
            "This server cannot receive files yet. Update Polaris and try again."
        );
    }
    const { size } = await stat(localPath);
    const body = createReadStream(localPath);
    if (onProgress) {
        let done = 0;
        let reported = 0;
        body.on("data", (chunk: Buffer | string) => {
            done += chunk.length;
            // Every couple of seconds rather than every chunk: each report is a
            // row update, and a chunk is 64 KB.
            if (Date.now() - reported > 2000 || done === size) {
                reported = Date.now();
                onProgress(done, size);
            }
        });
    }
    await ports.writeFile(container, path, body, size);
    const measured = await ports.runIn(container, ["sh", "-c", 'wc -c < "$1"', "polaris", path]);
    const bytes = Number.parseInt(measured.output.trim(), 10);
    if (measured.code !== 0 || bytes !== size) {
        throw new DatabaseOperationError(
            `The copy did not arrive whole inside the container (${Number.isFinite(bytes) ? bytes : 0} of ${size} bytes).`
        );
    }
}

/** Remove a staged file inside the container, whatever happened. */
export async function unstage(ports: RuntimePorts, container: string, path: string): Promise<void> {
    await ports.runIn(container, ["rm", "-f", "--", path]).catch(() => undefined);
}

/** A running operation's handle. */
export interface OperationHandle {
    readonly id: string;
    step(text: string): Promise<void>;
    progress(done: number, total?: number | null): Promise<void>;
    succeed(): Promise<void>;
    fail(error: unknown): Promise<string>;
}

/** A private path inside a container for one operation's staged file. */
export function stagedPath(operationId: string, extension: string): string {
    return `/tmp/polaris-${operationId}.${extension}`;
}

/**
 * Record an operation, first, so one that dies mid-way shows as never having
 * finished. Refuses a second while one is running on the same database: two
 * restores into one database at once is two DROP DATABASEs racing.
 */
export async function startOperation(
    databaseId: string,
    kind: "restore" | "upgrade" | "copy" | "recover",
    actorId: string | null
): Promise<OperationHandle> {
    const busy = await prisma.databaseOperation.findFirst({
        where: { databaseId, status: "running" },
        select: { kind: true, startedAt: true }
    });
    // A row left "running" by a process that restarted is not a real lock; after
    // six hours it is treated as abandoned.
    if (busy && Date.now() - busy.startedAt.getTime() < 6 * 3_600_000) {
        throw new DatabaseOperationError(`A ${busy.kind} is already running on this database.`);
    }
    const row = await prisma.databaseOperation.create({
        data: { databaseId, kind, actorId, step: "Starting" },
        select: { id: true }
    });
    return {
        id: row.id,
        step: async (text) => {
            await prisma.databaseOperation.update({ where: { id: row.id }, data: { step: text } });
        },
        progress: async (done, total) => {
            await prisma.databaseOperation.update({
                where: { id: row.id },
                data: {
                    doneBytes: BigInt(Math.max(0, Math.floor(done))),
                    ...(total != null ? { totalBytes: BigInt(total) } : {})
                }
            });
        },
        succeed: async () => {
            await prisma.databaseOperation.update({
                where: { id: row.id },
                data: { status: "succeeded", step: "Done", finishedAt: new Date() }
            });
        },
        fail: async (error) => {
            const reason =
                error instanceof DatabaseOperationError
                    ? error.message
                    : "It stopped on something Polaris did not expect. The details are in the server log.";
            if (!(error instanceof DatabaseOperationError)) {
                console.error(`database: ${kind} on ${databaseId} failed:`, error);
            }
            await prisma.databaseOperation.update({
                where: { id: row.id },
                data: { status: "failed", error: reason, finishedAt: new Date() }
            });
            return reason;
        }
    };
}

/** The operations of one database, newest first, for its screen. */
export async function listOperations(databaseId: string, ownerId: string) {
    const rows = await prisma.databaseOperation.findMany({
        where: { databaseId, database: { environment: { project: { ownerId } } } },
        orderBy: { startedAt: "desc" },
        take: 20
    });
    return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        step: row.step,
        doneBytes: Number(row.doneBytes),
        totalBytes: row.totalBytes === null ? null : Number(row.totalBytes),
        error: row.error,
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null
    }));
}
