"use server";

/**
 * Starting and ending a view of Polaris as somebody else. Kept at the top of the
 * app rather than under /admin because ending one has to be reachable from
 * wherever it took you - a control that only exists on the operator screens is a
 * control you cannot reach once you are looking at an account that has none.
 *
 * Who is allowed to do this is always the real owner of the session, never the
 * identity it is currently showing. That single rule is what makes nesting
 * impossible: viewing an account never becomes a way to start viewing from it.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { stopViewAs, viewAsRole, viewAsUser } from "@/lib/view-as-service";

const idSchema = z.string().uuid();

/** The administrator behind this session, whoever it is currently showing, or
 *  null when the session is not an administrator's. */
async function actor(): Promise<{ id: string; sessionId: string } | null> {
    // Through requireUser, so every session control (ban, lock, approval) is
    // applied before anything here runs.
    const user = await requireUser();
    const actorId = user.viewingAs?.actorId ?? user.id;
    const real = await prisma.user.findUnique({ where: { id: actorId }, select: { id: true, isAdmin: true } });
    if (!real?.isAdmin) return null;
    return { id: real.id, sessionId: user.sessionId };
}

export async function viewAsUserAction(userId: unknown): Promise<{ error?: string }> {
    const admin = await actor();
    if (!admin) return { error: (await getTranslations("nav"))("viewAs.adminOnlyAccount") };
    const parsed = idSchema.safeParse(userId);
    if (!parsed.success) return { error: (await getTranslations("nav"))("viewAs.unknownAccount") };

    const result = await viewAsUser(admin, parsed.data);
    if (!result.error) revalidatePath("/", "layout");
    return result;
}

export async function viewAsRoleAction(roleId: unknown): Promise<{ error?: string }> {
    const admin = await actor();
    if (!admin) return { error: (await getTranslations("nav"))("viewAs.adminOnlyRole") };
    const parsed = idSchema.safeParse(roleId);
    if (!parsed.success) return { error: (await getTranslations("nav"))("viewAs.unknownRole") };

    const result = await viewAsRole(admin, parsed.data);
    if (!result.error) revalidatePath("/", "layout");
    return result;
}

/** Go back to being yourself. */
export async function stopViewAsAction(): Promise<{ error?: string }> {
    const admin = await actor();
    if (!admin) return { error: (await getTranslations("nav"))("viewAs.nothingToLeave") };
    await stopViewAs(admin);
    revalidatePath("/", "layout");
    return {};
}
