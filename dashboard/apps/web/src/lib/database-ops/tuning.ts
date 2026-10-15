/**
 * The Tuning tab: what a database runs with, what its memory suggests, and
 * writing the suggestion followed by a restart.
 *
 * The memory is the database's own limit when it has one; otherwise what the
 * container reports in `/proc/meminfo`, which without a limit is the machine's.
 * That figure is shown but never applied: the machine also runs Polaris, the
 * services and other databases, and sizing every database to all of it would
 * overcommit it. The sizing and the statements are pure (`@polaris/core`,
 * `database-tuning`).
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { DatabaseOperationError, waitReady, withPorts } from "./ops";
import { accountScope, runCommands, type AccountScope } from "./accounts";

export interface TuningView {
    readonly engine: core.AccountEngine;
    readonly ramMb: number;
    /** Where the memory figure came from. */
    readonly ramSource: "limit" | "container";
    readonly settings: { name: string; current: string | null; suggested: string }[];
    /** Why applying is not offered, or null when it is. */
    readonly applyRefusal: TuningRefusal | null;
}

/**
 * Why a suggestion cannot be applied: MariaDB has no `SET PERSIST`, MySQL has
 * it from 8, and without a memory limit the figure is the whole machine's.
 */
export type TuningRefusal = "mariadb" | "mysqlOld" | "noLimit";

function engineRefusal(scope: AccountScope): TuningRefusal | null {
    if (scope.target.engine === "mariadb") return "mariadb";
    if (scope.target.engine === "mysql" && Number.parseInt(scope.context.version, 10) < 8) return "mysqlOld";
    return null;
}

function applyRefusal(scope: AccountScope, ramSource: TuningView["ramSource"]): TuningRefusal | null {
    return engineRefusal(scope) ?? (ramSource === "limit" ? null : "noLimit");
}

async function memoryOf(scope: AccountScope): Promise<{ ramMb: number; ramSource: "limit" | "container" }> {
    const row = await prisma.managedDatabase.findUnique({
        where: { id: scope.context.id },
        select: { memoryLimitMb: true }
    });
    if (row?.memoryLimitMb) return { ramMb: row.memoryLimitMb, ramSource: "limit" };
    const [output = ""] = await runCommands(scope, [core.MEMINFO_COMMAND]);
    const ramMb = core.parseMemInfo(output);
    if (!ramMb) throw new DatabaseOperationError("databases.memoryUnknown");
    return { ramMb, ramSource: "container" };
}

export async function tuningView(databaseId: string, ownerId: string): Promise<TuningView> {
    const scope = await accountScope(databaseId, ownerId);
    const memory = await memoryOf(scope);
    const [output = ""] = await runCommands(scope, [core.readTuningCommand(scope.target)]);
    const current = core.parseTuning(scope.target.engine, output);
    return {
        engine: scope.target.engine,
        ...memory,
        settings: core.suggestTuning(scope.target.engine, memory.ramMb).map((entry) => ({
            name: entry.name,
            current: current[entry.name] ?? null,
            suggested: entry.value
        })),
        applyRefusal: applyRefusal(scope, memory.ramSource)
    };
}

/**
 * Save the suggestion and restart the database so it takes effect. The values
 * applied are the ones suggested for its memory now, never ones sent in.
 */
export async function applyTuning(databaseId: string, ownerId: string): Promise<core.TuningSuggestion[]> {
    const scope = await accountScope(databaseId, ownerId);
    const refused = engineRefusal(scope);
    if (refused) throw new DatabaseOperationError(`databases.tuningRefused.${refused}`);
    const memory = await memoryOf(scope);
    if (memory.ramSource !== "limit") throw new DatabaseOperationError("databases.tuningRefused.noLimit");
    const settings = core.suggestTuning(scope.target.engine, memory.ramMb);
    await runCommands(scope, core.applyTuningCommands(scope.target, settings));
    await withPorts(scope.context, async (ports) => {
        await ports.container(scope.context.container, "restart");
        await waitReady(ports, scope.context);
    });
    return settings;
}
