/**
 * The Tuning tab: what a database runs with, what its memory suggests, and
 * writing the suggestion followed by a restart.
 *
 * The memory is the database's own limit when it has one; otherwise what the
 * container reports in `/proc/meminfo`, which without a limit is the machine's.
 * The sizing and the statements are pure (`@polaris/core`, `database-tuning`).
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
    readonly applyRefusal: string | null;
}

function applyRefusal(scope: AccountScope): string | null {
    if (scope.target.engine === "mariadb") return core.MARIADB_APPLY_REFUSAL;
    if (scope.target.engine === "mysql" && Number.parseInt(scope.context.version, 10) < 8) {
        return "Saving a setting from a connection needs MySQL 8 or later.";
    }
    return null;
}

async function memoryOf(scope: AccountScope): Promise<{ ramMb: number; ramSource: "limit" | "container" }> {
    const row = await prisma.managedDatabase.findUnique({
        where: { id: scope.context.id },
        select: { memoryLimitMb: true }
    });
    if (row?.memoryLimitMb) return { ramMb: row.memoryLimitMb, ramSource: "limit" };
    const [output] = await runCommands(scope, [core.MEMINFO_COMMAND]);
    const ramMb = core.parseMemInfo(output);
    if (!ramMb) throw new DatabaseOperationError("The container did not say how much memory it has.");
    return { ramMb, ramSource: "container" };
}

export async function tuningView(databaseId: string, ownerId: string): Promise<TuningView> {
    const scope = await accountScope(databaseId, ownerId);
    const memory = await memoryOf(scope);
    const [output] = await runCommands(scope, [core.readTuningCommand(scope.target)]);
    const current = core.parseTuning(scope.target.engine, output);
    return {
        engine: scope.target.engine,
        ...memory,
        settings: core.suggestTuning(scope.target.engine, memory.ramMb).map((entry) => ({
            name: entry.name,
            current: current[entry.name] ?? null,
            suggested: entry.value
        })),
        applyRefusal: applyRefusal(scope)
    };
}

/**
 * Save the suggestion and restart the database so it takes effect. The values
 * applied are the ones suggested for its memory now, never ones sent in.
 */
export async function applyTuning(databaseId: string, ownerId: string): Promise<core.TuningSuggestion[]> {
    const scope = await accountScope(databaseId, ownerId);
    const refusal = applyRefusal(scope);
    if (refusal) throw new DatabaseOperationError(refusal);
    const memory = await memoryOf(scope);
    const settings = core.suggestTuning(scope.target.engine, memory.ramMb);
    await runCommands(scope, core.applyTuningCommands(scope.target, settings));
    await withPorts(scope.context, async (ports) => {
        await ports.container(scope.context.container, "restart");
        await waitReady(ports, scope.context);
    });
    return settings;
}
