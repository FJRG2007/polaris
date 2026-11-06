"use server";

/**
 * How many server terminals each account may keep open. Administrator-only and
 * audited, like every other deployment-wide limit.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { getTranslations } from "@/lib/i18n/request";
import { MAX_TERMINAL_SESSION_CAP, setTerminalSessionCap } from "@/lib/terminal-session-cap";

const capSchema = z.number().int().min(1).max(MAX_TERMINAL_SESSION_CAP);

export async function saveTerminalSessionCapAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const t = await getTranslations("admin");
    const parsed = capSchema.safeParse(input);
    if (!parsed.success)
        return { error: t("settings.terminal.invalid", { max: MAX_TERMINAL_SESSION_CAP }) };
    try {
        await setTerminalSessionCap(parsed.data);
    } catch (caught) {
        console.error("[terminal] saving the session cap failed", caught);
        return { error: t("settings.terminal.notSaved") };
    }
    await recordAudit({
        actorId: admin.id,
        action: "terminal.sessions.cap",
        targetType: "instance",
        metadata: { cap: parsed.data }
    });
    revalidatePath("/admin/settings");
    return {};
}
