"use server";

/** Saving where Polar Code sessions run and how spares are kept. */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { appSettingsPath } from "@/lib/apps/app-settings";
import { getTranslations } from "@/lib/i18n/request";
import { recordAudit } from "@/lib/audit-service";
import { setSetting } from "@/lib/setting-store";
import { INSTANCE_KEY } from "@/lib/agents/session-capacity";
import { poolSchema, writePool } from "@/lib/agents/session-placement";
import { warmSchema, writeWarm } from "@/lib/agents/session-spares";
import { checkReach } from "@/lib/agents/pool-reach";
import { readPool } from "@/lib/agents/session-placement";
import type { Reach } from "@/lib/agents/pool-reach-state";

const saveSchema = z.object({
    pool: poolSchema,
    boxSessions: z.number().int().min(1).max(10_000),
    warm: warmSchema
});

export async function savePolarCodeAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const t = await getTranslations("polar");
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) return { error: t("admin.code.errors.invalid") };
    const { pool, boxSessions, warm } = parsed.data;

    // Only servers Polaris can run a container on. Checked here, not trusted
    // from the picker: placement would skip one without an engine forever, and
    // the screen would show it as part of a pool it never serves.
    const ids = pool.servers.map((server) => server.hostId);
    if (ids.length) {
        const found = await prisma.host.count({ where: { id: { in: ids }, dockerId: { not: null } } });
        if (found !== new Set(ids).size) return { error: t("admin.code.errors.noEngine") };
    }

    await Promise.all([
        writePool(pool),
        setSetting(INSTANCE_KEY, String(boxSessions)),
        writeWarm(warm)
    ]);
    await recordAudit({
        actorId: admin.id,
        action: "polar.code.update",
        targetType: "setting",
        targetId: "polar.code",
        metadata: { box: pool.box, boxSessions, servers: pool.servers.length, warm }
    });
    revalidatePath(appSettingsPath("polar"));
    return {};
}

/**
 * Ask a server whether it reaches Polaris, now. Any server with an engine may be
 * asked - one about to be added included - but only a pool server's answer is
 * kept, since that is the only one placement reads.
 */
export async function checkPoolReachAction(hostId: unknown): Promise<{ reach?: Reach; error?: string }> {
    await requireAdmin();
    const t = await getTranslations("polar");
    const parsed = z.string().uuid().safeParse(hostId);
    if (!parsed.success) return { error: t("admin.code.errors.invalid") };
    const host = await prisma.host.findFirst({
        where: { id: parsed.data, dockerId: { not: null } },
        select: { id: true }
    });
    if (!host) return { error: t("admin.code.errors.noEngine") };
    const pool = await readPool();
    const ids = pool.servers.map((server) => server.hostId);
    return { reach: await checkReach(host.id, ids.includes(host.id) ? ids : []) };
}
