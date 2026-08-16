"use server";

/**
 * The moderation queue's writes.
 *
 * One gate, and it is the instance's: `requireAdmin`. A report is about
 * something said in a room the person answering for it is not in, so there is no
 * per-conversation check to make - the administrator check is the whole
 * authority, which is exactly why it is the first line of every export here.
 */

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { settleReport } from "@/lib/chat/reports";

const PATH = "/admin/reports";

export async function settleReportAction(
    reportId: string,
    decision: "kept" | "removed"
): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    if (decision !== "kept" && decision !== "removed") return { error: "That is not a decision" };

    try {
        await settleReport({ id: admin.id }, reportId, decision);
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "That could not be settled" };
    }

    // Deleting somebody's message on the instance's authority is exactly the
    // kind of thing an account has to be able to answer for later.
    await recordAudit({
        actorId: admin.id,
        action: decision === "removed" ? "chat.report.removed" : "chat.report.kept",
        targetType: "chatReport",
        targetId: reportId
    });
    revalidatePath(PATH);
    return {};
}
