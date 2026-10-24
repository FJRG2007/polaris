/**
 * The gate in front of an intake form's public link (/forms/<token>).
 *
 * The same order every public link in Polaris uses: exists and is open, still
 * usable, address rules, fraud check, then the password. Both the page and the
 * submit action run it before they read or file anything. A form's cap counts
 * submissions, not opens: reading a form is free, sending one is what it limits.
 */

import { prisma } from "@polaris/db";
import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { clientIp } from "@/lib/request-context";
import { dymoIpAllowed } from "@/lib/dymo-service";
import { verifyLinkPassword } from "@polaris/core/link-password";
import {
    LINK_GUARD_FIELDS,
    checkLink,
    signUnlock,
    unlockCookieName,
    verifyUnlock
} from "@/lib/link-guards";

/** The unlock-cookie namespace form links are signed under. Its own, so a
 *  cookie solved for a task link is not a cookie that opens a form. */
const FORM_LINK_SCOPE = "form";

export type TaskFormGate =
    | { readonly ok: true; readonly formId: string }
    | { readonly ok: false; readonly reason: string };

const GATE_FIELDS = {
    id: true,
    enabled: true,
    passwordHash: true,
    expiresAt: true,
    maxSubmissions: true,
    allowedCidrs: true,
    allowedCountries: true,
    allowedContinents: true,
    ...LINK_GUARD_FIELDS,
    _count: { select: { submissions: true } }
} as const;

export function formUnlockCookie(formId: string): string {
    return unlockCookieName(FORM_LINK_SCOPE, formId);
}

export function signFormUnlock(formId: string, passwordHash: string | null): string {
    return signUnlock(FORM_LINK_SCOPE, formId, { passwordHash }, loadEnv().POLARIS_AUTH_SECRET);
}

/** Resolve a token and decide whether its form may be read and sent. A closed
 *  form answers not_found, so the URL cannot tell closed from never real. */
export async function gateTaskForm(token: string): Promise<TaskFormGate> {
    const form = await prisma.taskForm.findUnique({ where: { token }, select: GATE_FIELDS });
    if (!form || !form.enabled) return { ok: false, reason: "not_found" };

    const ip = await clientIp();
    const checked = await checkLink(
        {
            limits: {
                revokedAt: null,
                startsAt: form.startsAt,
                expiresAt: form.expiresAt,
                maxUses: form.maxSubmissions,
                useCount: form._count.submissions
            },
            rules: form,
            // The form's own "require sign-in" switch keeps the check it has
            // where the form is drawn; this adds the window and named accounts.
            guards: { allowedUsers: form.allowedUsers, linkSchedule: form.linkSchedule }
        },
        ip
    );
    if (!checked.ok) return { ok: false, reason: checked.reason };

    // Fraud check. A no-op unless the integration is on, and it fails open.
    if (!(await dymoIpAllowed(ip)).allowed) return { ok: false, reason: "ip_flagged" };

    if (form.passwordHash) {
        const solved = (await cookies()).get(formUnlockCookie(form.id))?.value;
        const secret = loadEnv().POLARIS_AUTH_SECRET;
        if (
            !verifyUnlock(
                FORM_LINK_SCOPE,
                form.id,
                solved,
                { passwordHash: form.passwordHash },
                secret
            )
        ) {
            return { ok: false, reason: "password_required" };
        }
    }

    return { ok: true, formId: form.id };
}

/** The form a password is being typed for, when it is still one that opens.
 *  Unknown and unusable answer the same null. */
export async function taskFormForUnlock(
    token: string
): Promise<{ readonly id: string; readonly passwordHash: string | null } | null> {
    const gate = await gateTaskForm(token);
    if (!gate.ok && gate.reason !== "password_required") return null;
    return prisma.taskForm.findUnique({
        where: { token },
        select: { id: true, passwordHash: true }
    });
}

/** Whether a password opens this form. Wrong and unset both answer false. */
export async function taskFormPasswordMatches(
    form: { readonly passwordHash: string | null },
    password: string
): Promise<boolean> {
    return form.passwordHash ? verifyLinkPassword(password, form.passwordHash) : false;
}
