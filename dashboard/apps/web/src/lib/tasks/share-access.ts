/**
 * The gate in front of a task's public link.
 *
 * The order every public link in Polaris uses: exists, still usable, address
 * rules, fraud check, then the password. Each refusal is a word rather than a
 * sentence, so the page decides what a visitor is told.
 */

import { prisma } from "@polaris/db";
import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { clientIp } from "@/lib/request-context";
import { dymoIpAllowed } from "@/lib/dymo-service";
import { verifyLinkPassword } from "@polaris/core/link-password";
import { checkLink, signUnlock, unlockCookieName, verifyUnlock } from "@/lib/link-guards";

/** The unlock-cookie namespace task links are signed under. Its own, so a
 *  cookie solved for a note is not a cookie that opens a task. */
const TASK_LINK_SCOPE = "task";

export type TaskShareGate =
    | { readonly ok: true; readonly shareId: string }
    | { readonly ok: false; readonly reason: string };

const GATE_FIELDS = {
    id: true,
    passwordHash: true,
    expiresAt: true,
    maxViews: true,
    views: true,
    allowedCidrs: true,
    allowedCountries: true,
    allowedContinents: true
} as const;

export function taskUnlockCookie(shareId: string): string {
    return unlockCookieName(TASK_LINK_SCOPE, shareId);
}

export function signTaskUnlock(shareId: string, passwordHash: string | null): string {
    return signUnlock(TASK_LINK_SCOPE, shareId, { passwordHash }, loadEnv().POLARIS_AUTH_SECRET);
}

/** Resolve a token and decide whether it opens anything. Counts nothing. */
export async function gateTaskShare(token: string): Promise<TaskShareGate> {
    const share = await prisma.taskShare.findUnique({ where: { token }, select: GATE_FIELDS });
    if (!share) return { ok: false, reason: "not_found" };

    const ip = await clientIp();
    const checked = await checkLink(
        {
            limits: {
                revokedAt: null,
                expiresAt: share.expiresAt,
                maxUses: share.maxViews,
                useCount: share.views
            },
            rules: share
        },
        ip
    );
    if (!checked.ok) return { ok: false, reason: checked.reason };

    // Fraud check. A no-op unless the integration is on, and it fails open.
    if (!(await dymoIpAllowed(ip)).allowed) return { ok: false, reason: "ip_flagged" };

    if (share.passwordHash) {
        const solved = (await cookies()).get(taskUnlockCookie(share.id))?.value;
        const secret = loadEnv().POLARIS_AUTH_SECRET;
        if (!verifyUnlock(TASK_LINK_SCOPE, share.id, solved, { passwordHash: share.passwordHash }, secret)) {
            return { ok: false, reason: "password_required" };
        }
    }

    return { ok: true, shareId: share.id };
}

/** The link a password is being typed for, when it is still one that opens.
 *  Unknown and unusable answer the same null. */
export async function taskShareForUnlock(
    token: string
): Promise<{ readonly id: string; readonly passwordHash: string | null } | null> {
    const gate = await gateTaskShare(token);
    if (!gate.ok && gate.reason !== "password_required") return null;
    return prisma.taskShare.findUnique({ where: { token }, select: { id: true, passwordHash: true } });
}

/** Whether a password opens this link. Wrong and unset both answer false. */
export async function taskSharePasswordMatches(
    share: { readonly passwordHash: string | null },
    password: string
): Promise<boolean> {
    return share.passwordHash ? verifyLinkPassword(password, share.passwordHash) : false;
}
