"use server";

/**
 * The breakdown behind a consumption chart, wherever the chart is drawn: a
 * machine in Places, a service in Deploy, a subject in Watch. One action, so
 * every screen answers with the same permission checks and the same words.
 */

import { requirePermission, userHasManage } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { watchText } from "@/lib/watch/words";
import { nothingToShow, type Breakdown } from "@/lib/watch/breakdown-shape";
import {
    breakdownRequestSchema,
    MACHINE_PERMISSION,
    subjectBreakdown
} from "@/lib/watch/subject-breakdown";

/**
 * What is using one of a subject's four metrics, ranked heaviest first.
 *
 * Reading a chart needs deploy.read and so does this; the machine-wide half of
 * it - what containers are on a server, what is on its disk - is gated a second
 * time inside on the permission the Servers app gates the same readings on, so a
 * reader who may watch a server but not manage the machine gets a sentence saying
 * so rather than a list of what is on somebody's box.
 *
 * Answers rather than throws. Every ordinary failure here is a fact about the
 * subject - the machine is off, nothing was recorded in that window, this metric
 * has no parts - and the dialog says it in words.
 */
export async function subjectBreakdownAction(input: unknown): Promise<Breakdown> {
    const user = await requirePermission("deploy.read");
    const parsed = breakdownRequestSchema.safeParse(input);
    const t = await getTranslations("watch");
    if (!parsed.success) return nothingToShow(t("text.nothingToBreakDown"));
    try {
        const canReadMachine = await userHasManage(user, MACHINE_PERMISSION);
        const answer = await subjectBreakdown({ id: user.id, canReadMachine }, parsed.data);
        // The service says its rows and reasons in English; the reader gets theirs.
        return {
            ...answer,
            note: answer.note ? watchText(t, answer.note) : answer.note,
            unavailable: answer.unavailable ? watchText(t, answer.unavailable) : answer.unavailable,
            rows: answer.rows.map((row) => ({
                ...row,
                label: watchText(t, row.label),
                detail: row.detail ? watchText(t, row.detail) : row.detail
            }))
        };
    } catch {
        // Whatever went wrong names a host, a socket or a query. What the reader
        // can do about it is the same either way.
        return nothingToShow(t("text.breakdownFailed"));
    }
}
