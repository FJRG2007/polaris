/**
 * How many cores each machine Polaris deploys to has.
 *
 * The collector records a service's CPU as a share of the whole machine, which
 * is what lets it sit beside the machine's own CPU on a chart - and which says
 * nothing about how much work it was until it is multiplied by the machine's
 * cores. A vCPU-hour is that product, so the count is kept here, keyed by the
 * same subject id the host series is written under.
 *
 * Recorded by the collector as it samples each machine, which it already asks
 * for its engine's details every minute - so this costs no extra call, and a
 * machine that gains cores is right within a minute of being sampled. Written
 * only when the number changes: the collector runs every minute and the count
 * almost never does.
 */

import { prisma } from "@polaris/db";

const KEY_PREFIX = "metrics.cpus.";

/** What this process last wrote per machine, so an unchanged count is not
 *  written again every minute. */
const written = new Map<string, number>();

/** Remember a machine's core count. Anything that is not a whole positive number
 *  - an engine that did not say - is ignored rather than stored as zero. */
export async function recordMachineCores(subjectId: string, cores: number): Promise<void> {
    if (!Number.isInteger(cores) || cores <= 0 || written.get(subjectId) === cores) return;
    const key = `${KEY_PREFIX}${subjectId}`;
    await prisma.setting.upsert({
        where: { key },
        create: { key, value: String(cores), scope: "global" },
        update: { value: String(cores) }
    });
    written.set(subjectId, cores);
}

/** Every machine's core count that is known, by the subject id its series is
 *  written under. A machine that has never been sampled is simply absent. */
export async function machineCores(): Promise<Map<string, number>> {
    const rows = await prisma.setting.findMany({
        where: { key: { startsWith: KEY_PREFIX } },
        select: { key: true, value: true }
    });
    const cores = new Map<string, number>();
    for (const row of rows) {
        const count = Number(row.value);
        if (Number.isInteger(count) && count > 0) cores.set(row.key.slice(KEY_PREFIX.length), count);
    }
    return cores;
}
