"use server";

/**
 * Sending, editing and taking back announcements.
 *
 * Administrator-only, every one of them, through the same `requireAdmin` the
 * page and the menu entry use. Inputs are parsed against the schema the form
 * validates with, sends are rate limited per administrator, and everything that
 * changes what people see is audited.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { getTranslations } from "@/lib/i18n/request";
import { rateLimit } from "@/lib/rate-limit-service";
import { findAccountsAsAdmin } from "@/lib/people-search";
import * as announcements from "@/lib/announcements/service";
import {
    addUpdateSchema,
    announcementIdSchema,
    audienceSchema,
    composeSchema,
    HISTORY_PAGE,
    normalizeCompose,
    type ComposeInput
} from "@/lib/announcements/schema";

const SENDS_PER_HOUR = 20;
const HOUR = 60 * 60_000;
const searchSchema = z.string().trim().min(2).max(100);

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; field?: string };

async function errorWords() {
    return getTranslations("announcements");
}

export async function countAudienceAction(input: unknown): Promise<{ count: number | null }> {
    await requireAdmin();
    const parsed = audienceSchema.safeParse(input);
    if (!parsed.success) return { count: null };
    return { count: await announcements.countAudience(parsed.data) };
}

export async function findRecipientsAction(
    query: string
): Promise<{ results: { id: string; name: string }[] }> {
    await requireAdmin();
    const term = searchSchema.safeParse(query);
    if (!term.success) return { results: [] };
    return { results: await findAccountsAsAdmin(term.data, 20) };
}

const historyPageSchema = z.object({
    after: announcementIdSchema.nullable().default(null),
    take: z.number().int().min(1).max(1000).default(HISTORY_PAGE)
});

/** The newest page, or `take` rows after the row `after` for the ones older than it. */
export async function historyAction(page: unknown = {}): Promise<announcements.HistoryRow[]> {
    await requireAdmin();
    const parsed = historyPageSchema.safeParse(page);
    if (!parsed.success) return [];
    return announcements.listHistory(parsed.data);
}

/** Parse and normalize, naming the field and the reason the form shows. */
async function parseCompose(
    input: unknown
): Promise<{ data: ComposeInput } | { error: string; field?: string }> {
    const parsed = composeSchema.safeParse(input);
    const t = await errorWords();
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const reason = issue?.message;
        const known = ["audience", "delivery", "window", "order", "link"] as const;
        const key = known.find((one) => one === reason) ?? "invalid";
        return { error: t(`admin.errors.${key}`), field: issue?.path.join(".") };
    }
    const data = normalizeCompose(parsed.data);
    if (data.title.length === 0) return { error: t("admin.errors.title"), field: "title" };
    return { data };
}

/** Create one, or change one that has not started (`id`). */
export async function saveAnnouncementAction(
    id: string | null,
    input: unknown
): Promise<Result<{ id: string }>> {
    const admin = await requireAdmin();
    const t = await errorWords();
    const parsed = await parseCompose(input);
    if ("error" in parsed) return { ok: false, error: parsed.error, field: parsed.field };
    if (id !== null && !announcementIdSchema.safeParse(id).success) {
        return { ok: false, error: t("admin.errors.gone") };
    }
    const limit = await rateLimit(`announcements:send:${admin.id}`, SENDS_PER_HOUR, HOUR);
    if (!limit.ok) {
        return {
            ok: false,
            error: t("admin.errors.rateLimited", {
                minutes: Math.max(1, Math.ceil(limit.retryAfterMs / 60_000))
            })
        };
    }
    try {
        if (id === null) {
            const row = await announcements.createAnnouncement(admin.id, parsed.data);
            await recordAudit({
                actorId: admin.id,
                action: "announcement.create",
                targetType: "announcement",
                targetId: row.id,
                metadata: {
                    kind: row.kind,
                    severity: row.severity,
                    reach: row.reach,
                    audience: parsed.data.audience
                }
            });
            return { ok: true, id: row.id };
        }
        const existing = await announcements.findAnnouncement(id);
        if (!existing) return { ok: false, error: t("admin.errors.gone") };
        const row = await announcements.updateAnnouncement(id, parsed.data);
        if (!row) return { ok: false, error: t("admin.errors.notEditable") };
        await recordAudit({
            actorId: admin.id,
            action: "announcement.update",
            targetType: "announcement",
            targetId: id,
            metadata: { reach: row.reach }
        });
        return { ok: true, id };
    } catch (error) {
        console.error("polaris: saving an announcement failed:", error);
        return { ok: false, error: t("admin.errors.failed") };
    }
}

export async function retractAnnouncementAction(id: string): Promise<Result> {
    const admin = await requireAdmin();
    const t = await errorWords();
    if (!announcementIdSchema.safeParse(id).success)
        return { ok: false, error: t("admin.errors.gone") };
    if (!(await announcements.retractAnnouncement(id)))
        return { ok: false, error: t("admin.errors.gone") };
    await recordAudit({
        actorId: admin.id,
        action: "announcement.retract",
        targetType: "announcement",
        targetId: id
    });
    return { ok: true };
}

/** Add an update ("taking longer than planned") to the announcement's details page. */
export async function addAnnouncementUpdateAction(input: unknown): Promise<Result> {
    const admin = await requireAdmin();
    const t = await errorWords();
    const parsed = addUpdateSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: t("admin.errors.update"), field: "body" };
    if (!(await announcements.addAnnouncementUpdate(admin.id, parsed.data.id, parsed.data.body)))
        return { ok: false, error: t("admin.errors.gone") };
    await recordAudit({
        actorId: admin.id,
        action: "announcement.addUpdate",
        targetType: "announcement",
        targetId: parsed.data.id
    });
    return { ok: true };
}

export async function endAnnouncementAction(
    id: string
): Promise<Result<{ outcome: "ended" | "cancelled" }>> {
    const admin = await requireAdmin();
    const t = await errorWords();
    if (!announcementIdSchema.safeParse(id).success)
        return { ok: false, error: t("admin.errors.gone") };
    const outcome = await announcements.endAnnouncement(id);
    if (!outcome) return { ok: false, error: t("admin.errors.gone") };
    await recordAudit({
        actorId: admin.id,
        action: outcome === "cancelled" ? "announcement.cancel" : "announcement.end",
        targetType: "announcement",
        targetId: id
    });
    return { ok: true, outcome };
}

/** The form an existing one was sent with, to edit or to send again. */
export async function composeOfAction(
    id: string
): Promise<Result<{ input: ComposeInput; people: { id: string; name: string }[] }>> {
    await requireAdmin();
    const t = await errorWords();
    if (!announcementIdSchema.safeParse(id).success)
        return { ok: false, error: t("admin.errors.gone") };
    const row = await announcements.findAnnouncement(id);
    if (!row) return { ok: false, error: t("admin.errors.gone") };
    const input = announcements.composeFrom(row);
    // The picked people by name, so the form shows who rather than ids.
    const people = await prisma.user.findMany({
        where: { id: { in: input.audience.userIds } },
        select: { id: true, name: true }
    });
    return { ok: true, input, people };
}
