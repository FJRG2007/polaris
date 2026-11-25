"use server";

import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { getTranslations } from "@/lib/i18n/request";
import { chatE2eeEnabled } from "@/lib/chat/e2ee/flag";
import * as migration from "@/lib/chat/e2ee/legacy-migration";

const channelId = z.string().trim().uuid();

/** Put one migrated conversation's history back as it was (inside the 30-day window). */
export async function rollBackChatMigrationAction(input: unknown): Promise<{ restored: number; kept: number } | { error: string }> {
    const user = await requireAdmin();
    const t = await getTranslations("admin");
    const parsed = channelId.safeParse(input);
    if (!parsed.success || !chatE2eeEnabled()) return { error: t("security.chatMigration.errors.notFound") };
    try {
        const outcome = await migration.rollBackConversation(parsed.data);
        if (outcome === "notCut") return { error: t("security.chatMigration.errors.notCut") };
        if (outcome === "expired") return { error: t("security.chatMigration.errors.expired", { days: migration.ROLLBACK_DAYS }) };
        await recordAudit({ actorId: user.id, action: "chat.migration.rollback", targetType: "chatChannel", targetId: parsed.data, metadata: outcome });
        return outcome;
    } catch (caught) {
        console.error("polaris: a migrated conversation could not be rolled back:", parsed.data, caught);
        return { error: t("security.chatMigration.errors.failed") };
    }
}

/** Let the migrator take a rolled-back conversation again. */
export async function migrateChatAgainAction(input: unknown): Promise<{ ok: true } | { error: string }> {
    const user = await requireAdmin();
    const t = await getTranslations("admin");
    const parsed = channelId.safeParse(input);
    if (!parsed.success || !chatE2eeEnabled()) return { error: t("security.chatMigration.errors.notFound") };
    if (!(await migration.migrateAgain(parsed.data))) return { error: t("security.chatMigration.errors.notRolledBack") };
    await recordAudit({ actorId: user.id, action: "chat.migration.retry", targetType: "chatChannel", targetId: parsed.data });
    return { ok: true };
}
