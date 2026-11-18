"use server";

/**
 * The default behind `polar.use` and `polar.spend`: who may use Polar, and who
 * may spend this deployment's keys in it, when no role, group policy or
 * account override says. Stored in Polar's policy as it always was, so an
 * install keeps the answer it had; only the screen that edits it moved here.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { recordAudit } from "@/lib/audit-service";
import { polarAudiencesSchema, savePolarPolicyPart } from "@/lib/polar/access";

/** Saved whole: the card sends both audiences every time, and the rest of the
 *  policy (edited in Polar's settings) is left as it is stored. */
export async function setPolarAudiencesAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = polarAudiencesSchema.safeParse(input);
    if (!parsed.success)
        return { error: (await getTranslations("admin"))("agents.errors.pickSetting") };

    await savePolarPolicyPart(parsed.data);
    await recordAudit({
        actorId: admin.id,
        action: "polar.access.update",
        metadata: {
            use: parsed.data.use.who,
            spend: parsed.data.spend.who,
            people: parsed.data.use.userIds.length + parsed.data.spend.userIds.length,
            groups: parsed.data.use.groupIds.length + parsed.data.spend.groupIds.length
        }
    });
    revalidatePath("/admin/roles");
    return {};
}

/** People an administrator may name in a Polar audience. */
export async function findPolarPeopleAction(
    query: unknown
): Promise<{ results: { id: string; name: string }[] }> {
    await requireAdmin();
    const term = z.string().trim().min(2).max(100).safeParse(query);
    if (!term.success) return { results: [] };
    const contains = { contains: term.data, mode: "insensitive" as const };
    const found = await prisma.user.findMany({
        where: { OR: [{ name: contains }, { email: contains }, { username: contains }] },
        select: { id: true, name: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: 20
    });
    return { results: found };
}

/** Groups an administrator may name in a Polar audience, for a deployment with
 *  more of them than the card lists. */
export async function findPolarGroupsAction(
    query: unknown
): Promise<{ results: { id: string; name: string }[] }> {
    await requireAdmin();
    const term = z.string().trim().min(2).max(100).safeParse(query);
    if (!term.success) return { results: [] };
    const found = await prisma.group.findMany({
        where: { name: { contains: term.data, mode: "insensitive" } },
        select: { id: true, name: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: 20
    });
    return { results: found };
}
