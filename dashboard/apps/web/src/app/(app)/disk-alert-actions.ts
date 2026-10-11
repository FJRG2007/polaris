"use server";

/**
 * The disk warning every administrator sees on every screen, and the button on
 * it that hands back what Polaris can safely remove.
 *
 * Gated like the servers screen: how a machine's disk is used, and pruning it,
 * belongs to whoever manages the system. Answers empty rather than redirecting,
 * because this is asked from a banner on every page.
 */

import { z } from "zod";
import { recordAudit } from "@/lib/audit-service";
import { getTranslations } from "@/lib/i18n/request";
import { requireUser, sessionCan, type SessionUser } from "@/lib/session";
import {
    freeDiskSpace,
    keepDiskReading,
    lastDiskReadings,
    readDisk,
    watchDisks,
    type DiskReading
} from "@/lib/deploy/disk-watch";

/** A reading older than this is read again before it is shown. */
const STALE_MS = 30 * 60_000;

const machineSchema = z.union([z.literal("local"), z.string().uuid()]);

async function manager(): Promise<SessionUser | null> {
    const user = await requireUser();
    return (await sessionCan(user, "system.manage")) ? user : null;
}

/** The machines whose disk is low or critical, as last read. */
export async function diskAlertsAction(): Promise<DiskReading[]> {
    if (!(await manager())) return [];
    let readings = await lastDiskReadings();
    const newest = Math.max(0, ...readings.map((one) => Date.parse(one.checkedAt) || 0));
    if (readings.length === 0 || Date.now() - newest > STALE_MS) {
        readings = await watchDisks().catch(() => readings);
    }
    return readings.filter((one) => one.level !== "ok");
}

/** Free what Polaris can on one machine, and read its disk again. */
export async function freeDiskSpaceAction(
    machine: string
): Promise<{ freed?: number; reading?: DiskReading | null; error?: string }> {
    const user = await manager();
    const t = await getTranslations("components");
    if (!user) return { error: t("diskAlert.notAllowed") };
    const parsed = machineSchema.safeParse(typeof machine === "string" ? machine.trim() : machine);
    if (!parsed.success) return { error: t("diskAlert.unknownServer") };

    const freed = await freeDiskSpace(parsed.data).catch(() => null);
    if (freed === null) return { error: t("diskAlert.unreachable") };
    const reading = await readDisk(parsed.data).catch(() => null);
    if (reading) await keepDiskReading(reading).catch(() => undefined);
    await recordAudit({
        actorId: user.id,
        action: "server.space.reclaimed",
        targetType: "host",
        targetId: parsed.data,
        metadata: { freed }
    });
    return { freed, reading };
}
