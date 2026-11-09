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
