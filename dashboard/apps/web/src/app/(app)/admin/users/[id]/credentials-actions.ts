"use server";

/**
 * The credential changes an administrator makes on somebody else's account.
 *
 * Every one needs a fresh step-up proof from the administrator's own session
 * ("admin-credentials", see `step-up-grant`): these are the actions that hand
 * somebody a way into an account, and a screen left open must not be enough.
 * The decisions - rank, rate limits, the link itself - live in the service.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { stepUpGranted } from "@/lib/step-up-grant";
import { getTranslations } from "@/lib/i18n/request";
import { publishAccessChange } from "@/lib/access-live";
import { validationMessage } from "@/components/i18n/validation-message";
import { accountEmailSchema, temporaryPasswordSchema } from "./credential-schemas";
import {
    changeAccountEmail,
    credentialOptions,
    issueResetLink,
    mailResetLink,
    setTemporaryPassword,
    type CredentialOptions
} from "@/lib/admin-credentials-service";

const idSchema = z.string().uuid();

/** A refusal, flagged when the cure is a step-up proof rather than a retry. */
type Refused = { error: string; stepUp?: boolean };

/** The administrator, once their step-up proof for this is confirmed. Each
 *  action calls requireAdmin itself first, so the guard is visible where it runs. */
async function provedAdmin(admin: { id: string; sessionId: string }): Promise<{ id: string } | Refused> {
    if (!(await stepUpGranted(admin.id, admin.sessionId, "admin-credentials"))) {
        return { error: (await getTranslations("admin"))("usersDetail.errors.confirmFirst"), stepUp: true };
    }
    return { id: admin.id };
}

async function unknownAccount(): Promise<{ error: string }> {
    return { error: (await getTranslations("admin"))("usersDetail.errors.unknownAccount") };
}

/** What the section can offer, read after the paint. */
export async function credentialOptionsAction(userId: unknown): Promise<CredentialOptions | { error: string }> {
    await requireAdmin();
    const parsed = idSchema.safeParse(userId);
    if (!parsed.success) return unknownAccount();
    return credentialOptions(parsed.data);
}

export async function issueResetLinkAction(
    userId: unknown
): Promise<{ url?: string; expiresAt?: string; error?: string; stepUp?: boolean }> {
    const parsed = idSchema.safeParse(userId);
    if (!parsed.success) return unknownAccount();
    const admin = await provedAdmin(await requireAdmin());
    if ("error" in admin) return admin;
    return issueResetLink(admin.id, parsed.data);
}

export async function mailResetLinkAction(userId: unknown): Promise<{ error?: string; stepUp?: boolean }> {
    const parsed = idSchema.safeParse(userId);
    if (!parsed.success) return unknownAccount();
    const admin = await provedAdmin(await requireAdmin());
    if ("error" in admin) return admin;
    return mailResetLink(admin.id, parsed.data);
}

export async function setTemporaryPasswordAction(userId: unknown, input: unknown): Promise<{ error?: string; stepUp?: boolean }> {
    const target = idSchema.safeParse(userId);
    if (!target.success) return unknownAccount();
    const parsed = temporaryPasswordSchema.safeParse(input);
    const tv = await getTranslations("validation");
    if (!parsed.success) return { error: validationMessage(tv, parsed.error.issues[0]?.message ?? "") };
    const admin = await provedAdmin(await requireAdmin());
    if ("error" in admin) return admin;
    const result = await setTemporaryPassword(admin.id, target.data, parsed.data.password);
    if (result.error) return { error: validationMessage(tv, result.error) };
    publishAccessChange({ userIds: [target.data] });
    revalidatePath(`/admin/users/${target.data}`, "layout");
    return {};
}

export async function changeAccountEmailAction(userId: unknown, input: unknown): Promise<{ error?: string; stepUp?: boolean }> {
    const target = idSchema.safeParse(userId);
    if (!target.success) return unknownAccount();
    const parsed = accountEmailSchema.safeParse(input);
    if (!parsed.success) {
        return { error: validationMessage(await getTranslations("validation"), parsed.error.issues[0]?.message ?? "") };
    }
    const admin = await provedAdmin(await requireAdmin());
    if ("error" in admin) return admin;
    const result = await changeAccountEmail(admin.id, target.data, parsed.data);
    if (!result.error) {
        revalidatePath(`/admin/users/${target.data}`, "layout");
        revalidatePath("/admin/users");
    }
    return result;
}
