/**
 * What an administrator has to look at, about people rather than about messages.
 *
 * The instance already had a queue for a thing that was said. This is the other
 * half of the same job: somebody reported a person, or an account said something
 * is wrong with itself - which is what a lockdown is. Both are read from one
 * screen, because "what needs looking at" is one question and an instance that
 * answers it in two places answers it in neither.
 *
 * A case is opened by the person or the account it concerns and settled by an
 * administrator, and nothing in between: there is no "being looked at", for the
 * reason the message queue has none - a queue with a middle state is a queue with
 * rows nobody owns.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { recordAudit } from "@/lib/audit-service";
import { notify } from "@/lib/notifications/dispatch";
import { alertAdmins } from "@/lib/notifications/admins";
import { translatorFor } from "@/lib/i18n/translate";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { wordsFor } from "@/lib/notifications/notice-words";
import { readerWords } from "@/lib/i18n/reader-words";

/** One case, as the queue draws it. */
export interface SafetyCaseView {
    readonly id: string;
    readonly kind: core.SafetyCaseKind;
    readonly status: core.SafetyCaseStatus;
    readonly reason: string;
    readonly note: string;
    readonly outcome: string;
    readonly subject: { readonly id: string; readonly name: string; readonly email: string };
    /** Null for a lockdown, which the account raised about itself. */
    readonly reporter: { readonly id: string; readonly name: string } | null;
    readonly handledBy: { readonly id: string; readonly name: string } | null;
    readonly handledAt: string | null;
    readonly createdAt: string;
    /** Whether the account is still locked down right now, for a lockdown case.
     *  Read live rather than from the row: an owner can lift it themselves, and a
     *  queue saying otherwise would send somebody to look at nothing. */
    readonly stillLocked: boolean;
}

const CASE_SELECT = {
    id: true,
    kind: true,
    status: true,
    reason: true,
    note: true,
    outcome: true,
    handledAt: true,
    createdAt: true,
    subject: {
        select: { id: true, name: true, email: true, security: { select: { lockdownAt: true } } }
    },
    reporter: { select: { id: true, name: true } },
    handledBy: { select: { id: true, name: true } }
} as const;

interface CaseRow {
    id: string;
    kind: string;
    status: string;
    reason: string;
    note: string;
    outcome: string;
    handledAt: Date | null;
    createdAt: Date;
    subject: {
        id: string;
        name: string;
        email: string;
        security: { lockdownAt: Date | null } | null;
    };
    reporter: { id: string; name: string } | null;
    handledBy: { id: string; name: string } | null;
}

function toView(row: CaseRow): SafetyCaseView {
    return {
        id: row.id,
        kind: row.kind as core.SafetyCaseKind,
        status: row.status as core.SafetyCaseStatus,
        reason: row.reason,
        note: row.note,
        outcome: row.outcome,
        subject: { id: row.subject.id, name: row.subject.name, email: row.subject.email },
        reporter: row.reporter,
        handledBy: row.handledBy,
        handledAt: row.handledAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        stillLocked: row.subject.security?.lockdownAt != null
    };
}

/** The queue, newest first. `all` is for reading back what was decided. */
export async function listSafetyCases(
    status: core.SafetyCaseStatus | "all"
): Promise<SafetyCaseView[]> {
    const rows = await prisma.safetyCase.findMany({
        where: status === "all" ? {} : { status },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: CASE_SELECT
    });
    return rows.map((row) => toView(row as CaseRow));
}

/** How many are waiting, for the badge on the admin nav. */
export function openCaseCount(): Promise<number> {
    return prisma.safetyCase.count({ where: { status: "open" } });
}

/**
 * Open the case an account raises about itself when it locks down.
 *
 * One open case per account: pressing the switch twice is the same emergency,
 * and a queue with four rows for one person is a queue nobody reads. A second
 * press updates what the first one said rather than adding to it.
 */
export async function openLockdownCase(userId: string, note: string): Promise<void> {
    const existing = await prisma.safetyCase.findFirst({
        where: { subjectId: userId, kind: "lockdown", status: "open" },
        select: { id: true }
    });
    if (existing) {
        await prisma.safetyCase.update({ where: { id: existing.id }, data: { note } });
    } else {
        await prisma.safetyCase.create({
            data: { kind: "lockdown", subjectId: userId, reason: "lockdown", note }
        });
    }
    const who = await subjectName(userId);
    // Each administrator reads it in their own language.
    const said = (locale: core.Locale) => {
        const t = translatorFor(locale, "notices");
        return {
            title: t("safety.lockedDownTitle"),
            body: describeSubject(t, who, note || t("safety.lockedDownNoDetail"))
        };
    };
    await alertAdmins({ ...said(core.DEFAULT_LOCALE), say: said, actionRequired: true });
}

/** Somebody reported a person. */
export async function reportUser(
    reporterId: string,
    input: core.UserReportInput
): Promise<{ error?: string }> {
    // i18n-ignore said in the reader's words by the report action
    if (input.subjectId === reporterId) return { error: "You cannot report yourself." };
    const subject = await prisma.user.findUnique({
        where: { id: input.subjectId },
        select: { id: true }
    });
    // The same answer whether the account is not there or not reachable: a
    // refusal that told them apart would answer a question about who exists.
    // i18n-ignore said in the reader's words by the report action
    if (!subject) return { error: "That account could not be reported." };

    // One open report per person per reporter. A second press is the same
    // report, and what it says is the newer of the two.
    const existing = await prisma.safetyCase.findFirst({
        where: { kind: "user", subjectId: input.subjectId, reporterId, status: "open" },
        select: { id: true }
    });
    if (existing) {
        await prisma.safetyCase.update({
            where: { id: existing.id },
            data: { reason: input.reason, note: input.note }
        });
        return {};
    }

    await prisma.safetyCase.create({
        data: {
            kind: "user",
            subjectId: input.subjectId,
            reporterId,
            reason: input.reason,
            note: input.note
        }
    });
    await recordAudit({
        actorId: reporterId,
        action: "safety.user.reported",
        targetType: "user",
        targetId: input.subjectId,
        metadata: { reason: input.reason }
    });
    const who = await subjectName(input.subjectId);
    const said = (locale: core.Locale) => {
        const t = translatorFor(locale, "notices");
        const reason = translatorFor(locale, "components")(`report.reasons.${input.reason}`);
        return {
            title: t("safety.reportedTitle"),
            body: describeSubject(
                t,
                who,
                input.note.trim() ? t("safety.reportedDetail", { reason, note: input.note.trim() }) : t("safety.reportedReason", { reason })
            )
        };
    };
    await alertAdmins({ ...said(core.DEFAULT_LOCALE), say: said, actionRequired: false });
    return {};
}

/** Settle one, with the record of who decided and why. */
export async function settleSafetyCase(
    adminId: string,
    input: core.SettleCaseInput
): Promise<{ error?: string }> {
    const written = await prisma.safetyCase.updateMany({
        where: { id: input.caseId, status: "open" },
        data: {
            status: input.status,
            outcome: input.outcome,
            handledById: adminId,
            handledAt: new Date()
        }
    });
    if (written.count === 0) return { error: (await readerWords("admin"))("safety.errors.alreadySettled") };

    const settled = await prisma.safetyCase.findUnique({
        where: { id: input.caseId },
        select: { kind: true, subjectId: true }
    });
    await recordAudit({
        actorId: adminId,
        action: "safety.case.settled",
        targetType: "safety-case",
        targetId: input.caseId,
        metadata: { status: input.status }
    });

    // The account that raised it is told what came of it. Only for a lockdown:
    // somebody who reported a person is not owed a verdict on that person, and
    // telling them would be handing over a decision about somebody else.
    if (settled?.kind === "lockdown") {
        const t = await wordsFor(settled.subjectId, "notices");
        await notify({
            userId: settled.subjectId,
            event: "account.security",
            title: t("safety.settledTitle"),
            body: input.outcome || t("safety.settledBody"),
            href: "/account/security"
        }).catch(() => undefined);
    }
    return {};
}

/** What the alert says about whose account it is. */
async function subjectName(userId: string): Promise<{ name: string; email: string } | null> {
    return prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true }
    });
}

/** Who it is about and what was said, in one administrator's words. */
function describeSubject(
    t: NamespaceTranslator<"notices">,
    who: { name: string; email: string } | null,
    detail: string
): string {
    const named = who ? t("safety.subject", { name: who.name, email: who.email }) : t("safety.anAccount");
    return detail ? t("safety.subjectSaid", { who: named, detail }) : named;
}
