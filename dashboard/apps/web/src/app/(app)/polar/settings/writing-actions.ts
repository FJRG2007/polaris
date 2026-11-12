"use server";

/**
 * The Writing section of Polar's settings: the organizations this person
 * writes for, each with its shared writing guide, and saving one. Reading a
 * guide is being on the roster; changing it is `settings.manage` in that
 * organization, checked here whatever the screen showed. Somebody viewing as
 * another account reads, and never writes.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { polarAccessFor } from "@/lib/polar/access";
import { getTranslations } from "@/lib/i18n/request";
import { listMyOrgs, orgCan, requireOrgPermission, resolveOrgAccess } from "@/lib/orgs/org-service";

/** Longest guide an organization keeps, in characters. */
const GUIDE_MAX = 8_000;

export interface OrgWritingGuide {
    id: string;
    name: string;
    guide: string;
    canEdit: boolean;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export async function orgWritingGuidesAction(): Promise<Result<OrgWritingGuide[]>> {
    const t = await getTranslations("polar");
    const user = await requireUser();
    if (!(await polarAccessFor(user.id)).use) {
        return { ok: false, error: t("settings.writing.errors.noAccess") };
    }
    // A restricted member opens nothing in the organization, so not this either.
    const orgs = (await listMyOrgs(user.id)).filter(
        (org) => !org.restricted && org.role !== "successor"
    );
    if (orgs.length === 0) return { ok: true, value: [] };
    const [rows, access] = await Promise.all([
        prisma.organization.findMany({
            where: { id: { in: orgs.map((org) => org.id) } },
            select: { id: true, writingGuide: true }
        }),
        Promise.all(orgs.map((org) => resolveOrgAccess({ id: user.id, isAdmin: false }, org.id)))
    ]);
    const guides = new Map(rows.map((row) => [row.id, row.writingGuide]));
    return {
        ok: true,
        value: orgs.map((org, index) => ({
            id: org.id,
            name: org.name,
            guide: guides.get(org.id) ?? "",
            canEdit: !user.viewingAs && orgCan(access[index] ?? null, "settings.manage")
        }))
    };
}

const saveSchema = z.object({
    orgId: z.string().uuid(),
    guide: z.string().trim().max(GUIDE_MAX)
});

export async function saveOrgWritingGuideAction(input: unknown): Promise<Result<string>> {
    const t = await getTranslations("polar");
    const user = await requireUser();
    if (user.viewingAs) return { ok: false, error: t("settings.writing.errors.viewingAs") };
    if (!(await polarAccessFor(user.id)).use) {
        return { ok: false, error: t("settings.writing.errors.noAccess") };
    }
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: t("settings.writing.errors.tooLong") };
    try {
        await requireOrgPermission(
            { id: user.id, isAdmin: false },
            parsed.data.orgId,
            "settings.manage"
        );
    } catch {
        return { ok: false, error: t("settings.writing.errors.notAllowed") };
    }
    const before = await prisma.organization.findUnique({
        where: { id: parsed.data.orgId },
        select: { writingGuide: true }
    });
    if (before?.writingGuide === parsed.data.guide) return { ok: true, value: parsed.data.guide };
    await prisma.organization.update({
        where: { id: parsed.data.orgId },
        data: { writingGuide: parsed.data.guide }
    });
    await recordAudit({
        actorId: user.id,
        action: "org.writing-guide",
        targetType: "organization",
        targetId: parsed.data.orgId,
        orgId: parsed.data.orgId,
        metadata: { length: parsed.data.guide.length }
    });
    return { ok: true, value: parsed.data.guide };
}
