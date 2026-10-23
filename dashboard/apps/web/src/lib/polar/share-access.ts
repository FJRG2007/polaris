/**
 * The gate in front of a shared Polar chat's public link.
 *
 * The order every public link in Polaris uses: exists, still usable, address
 * rules, fraud check, then the password. The page and the file route both ask
 * this before they read anything, so a file cannot be fetched past a password
 * the page would have asked for.
 */

import { prisma } from "@polaris/db";
import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { hashToken } from "@polaris/core/tokens";
import { clientIp } from "@/lib/request-context";
import { dymoIpAllowed } from "@/lib/dymo-service";
import { verifyLinkPassword } from "@polaris/core/link-password";
import { checkLink, signUnlock, unlockCookieName, verifyUnlock } from "@/lib/link-guards";

/** Its own unlock namespace, so a cookie solved for a note opens no chat. */
const POLAR_LINK_SCOPE = "polar";

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

export type PolarShareGate =
    | { readonly ok: true; readonly shareId: string }
    | { readonly ok: false; readonly reason: string };

const GATE_FIELDS = {
    id: true,
    linkEnabled: true,
    passwordHash: true,
    expiresAt: true,
    maxViews: true,
    views: true,
    allowedCidrs: true,
    allowedCountries: true,
    allowedContinents: true
} as const;

export function polarUnlockCookie(shareId: string): string {
    return unlockCookieName(POLAR_LINK_SCOPE, shareId);
}

export function signPolarUnlock(shareId: string, passwordHash: string | null): string {
    return signUnlock(POLAR_LINK_SCOPE, shareId, { passwordHash }, loadEnv().POLARIS_AUTH_SECRET);
}

/**
 * Resolve a token and decide whether it opens anything. Counts nothing.
 * `withinCap: false` skips the view cap, for a request (a file) that belongs to
 * a page whose own open already took a view.
 */
export async function gatePolarShare(
    token: string,
    { withinCap = true }: { readonly withinCap?: boolean } = {}
): Promise<PolarShareGate> {
    if (!TOKEN_SHAPE.test(token)) return { ok: false, reason: "not_found" };
    const share = await prisma.polarThreadShare.findUnique({
        where: { tokenHash: hashToken(token) },
        select: GATE_FIELDS
    });
    if (!share || share.linkEnabled === false) return { ok: false, reason: "not_found" };

    const ip = await clientIp();
    const checked = await checkLink(
        {
            limits: {
                revokedAt: null,
                expiresAt: share.expiresAt,
                maxUses: withinCap ? share.maxViews : null,
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
        const solved = (await cookies()).get(polarUnlockCookie(share.id))?.value;
        const secret = loadEnv().POLARIS_AUTH_SECRET;
        if (
            !verifyUnlock(
                POLAR_LINK_SCOPE,
                share.id,
                solved,
                { passwordHash: share.passwordHash },
                secret
            )
        ) {
            return { ok: false, reason: "password_required" };
        }
    }

    return { ok: true, shareId: share.id };
}

/**
 * Count one opening, conditionally: two people opening the last permitted view
 * at the same moment must not both get it. False when the cap was reached.
 */
export async function countPolarShareView(shareId: string): Promise<boolean> {
    const share = await prisma.polarThreadShare.findUnique({
        where: { id: shareId },
        select: { maxViews: true }
    });
    if (!share) return false;
    const counted = await prisma.polarThreadShare.updateMany({
        where: {
            id: shareId,
            ...(share.maxViews === null ? {} : { views: { lt: share.maxViews } })
        },
        data: { views: { increment: 1 } }
    });
    return counted.count > 0;
}

/** The link a password is being typed for, when it is still one that opens. */
export async function polarShareForUnlock(
    token: string
): Promise<{ readonly id: string; readonly passwordHash: string | null } | null> {
    const gate = await gatePolarShare(token);
    if (!gate.ok && gate.reason !== "password_required") return null;
    return prisma.polarThreadShare.findUnique({
        where: { tokenHash: hashToken(token) },
        select: { id: true, passwordHash: true }
    });
}

/** Whether a password opens this link. Wrong and unset both answer false. */
export async function polarSharePasswordMatches(
    share: { readonly passwordHash: string | null },
    password: string
): Promise<boolean> {
    return share.passwordHash ? verifyLinkPassword(password, share.passwordHash) : false;
}
