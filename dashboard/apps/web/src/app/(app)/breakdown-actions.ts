"use server";

/**
 * The breakdown behind a consumption chart, wherever the chart is drawn: a
 * machine in Places, a service in Deploy, a subject in Watch. One action, so
 * every screen answers with the same permission checks and the same words.
 */

import { requirePermission, sessionCan, userHasManage } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import type { NamespaceKey } from "@/lib/i18n/types";
import { watchText } from "@/lib/watch/words";
import { appName } from "@/lib/apps/app-words";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import type { BreakdownRow } from "@/lib/watch/breakdown-shape";
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
        const [canReadMachine, canRunDeploy, parts, catalog] = await Promise.all([
            userHasManage(user, MACHINE_PERMISSION),
            // The restart action refuses without it, so a row never offers it.
            sessionCan(user, "deploy.manage"),
            getTranslations("components"),
            getTranslations("catalog")
        ]);
        const answer = await subjectBreakdown({ id: user.id, canReadMachine }, parsed.data);
        // The service says its rows and reasons in English; the reader gets theirs.
        return {
            ...answer,
            note: answer.note ? watchText(t, answer.note) : answer.note,
            unavailable: answer.unavailable ? watchText(t, answer.unavailable) : answer.unavailable,
            rows: answer.rows.map((row) => {
                const named = containerWords(t, catalog, row);
                if (named) return { ...row, ...named };
                const part = row.part ? `footprint.parts.${row.part}` : null;
                return {
                    ...row,
                    label: part
                        ? parts(`${part}.label` as NamespaceKey<"components">)
                        : watchText(t, row.label),
                    detail: part
                        ? parts(`${part}.summary` as NamespaceKey<"components">)
                        : row.detail
                          ? watchText(t, row.detail)
                          : row.detail,
                    service: row.service
                        ? { ...row.service, canRestart: row.service.canRestart && canRunDeploy }
                        : row.service
                };
            })
        };
    } catch {
        // Whatever went wrong names a host, a socket or a query. What the reader
        // can do about it is the same either way.
        return nothingToShow(t("text.breakdownFailed"));
    }
}

/** An official app's, a Code session's or a stranger's container, in the reader's
 *  words; null for every other row. */
function containerWords(
    t: NamespaceTranslator<"watch">,
    catalog: NamespaceTranslator<"catalog">,
    row: BreakdownRow
): { label: string; detail: string | null } | null {
    if (row.app) {
        const summary = `apps.${row.app.install}.summary`;
        return {
            label: appName(catalog, row.app.owner, row.label),
            detail: catalog.has(summary) ? catalog(summary) : row.detail
        };
    }
    if (row.session) {
        const { known, repository, owner } = row.session;
        const detail = !known
            ? t("breakdown.session.orphan")
            : repository && owner
              ? t("breakdown.session.repoOwner", { repository, owner })
              : repository
                ? t("breakdown.session.repo", { repository })
                : owner
                  ? t("breakdown.session.owner", { owner })
                  : t("breakdown.session.plain");
        return { label: known ? row.label : t("breakdown.session.untitled"), detail };
    }
    if (row.origin) {
        return {
            label: row.label,
            detail: t(row.origin === "polaris" ? "breakdown.origin.polaris" : "breakdown.origin.elsewhere")
        };
    }
    return null;
}
