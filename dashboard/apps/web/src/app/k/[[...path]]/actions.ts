"use server";

/**
 * The password gate in front of a grant link (`/k/<token>`).
 *
 * Public: the token plus the password is the credential. Guesses are limited
 * per link and per address exactly as every other link password gate is, and
 * every answer is one of the same generic sentences, so the form cannot be
 * used to learn which links exist.
 */

import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { verifyLinkPassword } from "@polaris/core/link-password";
import { getTranslations } from "@/lib/i18n/request";
import { clientIp, hashForLog } from "@/lib/request-context";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";
import { UNLOCK_TTL_SECONDS } from "@/lib/link-guards";
import {
    grantLinkPassword,
    grantLinkUnlockCookie,
    linkReach,
    recordGrantUse,
    signGrantLinkUnlock,
    spendGrant
} from "@/lib/access/grants";

/** Terminal viewer tickets one link may mint from one address, and the window. */
const TERMINAL_OPEN_LIMIT = 30;
const TERMINAL_OPEN_WINDOW_MS = 10 * 60 * 1000;

/** Attempts allowed before the gate blocks, and the window. */
const UNLOCK_LIMIT = 10;
const UNLOCK_WINDOW_MS = 15 * 60 * 1000;

export async function unlockGrantLinkAction(
    token: string,
    password: string
): Promise<{ error?: string }> {
    const words = await getTranslations("drive");
    if (typeof token !== "string" || typeof password !== "string" || password.length > 256) {
        return { error: words("errors.wrongPassword") };
    }
    const link = await grantLinkPassword(token);
    if (!link) return { error: words("errors.linkUnavailable") };

    const limitKey = `grant-link-unlock:${link.id}:${hashForLog(await clientIp()) ?? "unknown"}`;
    if (!(await rateLimit(limitKey, UNLOCK_LIMIT, UNLOCK_WINDOW_MS)).ok) {
        return { error: words("errors.tooManyAttempts") };
    }
    if (!(await verifyLinkPassword(password, link.passwordHash))) {
        return { error: words("errors.wrongPassword") };
    }

    await resetRateLimit(limitKey);
    const env = loadEnv();
    (await cookies()).set(
        grantLinkUnlockCookie(link.id),
        signGrantLinkUnlock(link.id, link.passwordHash, env.POLARIS_AUTH_SECRET),
        {
            httpOnly: true,
            sameSite: "lax",
            secure: env.POLARIS_SECURE_COOKIES,
            path: "/",
            maxAge: UNLOCK_TTL_SECONDS
        }
    );
    return {};
}

/**
 * A one-shot viewer ticket for the terminal a link was handed out for. The
 * link is judged again here (dates, hours, uses, address, password) and the relay
 * judges it on every frame after, watching only: a link never types.
 */
export async function openTerminalLinkAction(
    token: unknown
): Promise<{ ticket: string; access: "view" } | { error: string }> {
    const [account, gone] = await Promise.all([getTranslations("account"), getTranslations("publicPages")]);
    const reached = typeof token === "string" ? await linkReach(token) : null;
    // Loaded here, not at the top: the password gate above shares this module
    // and has no use for the relay's key and session machinery.
    const [{ linkedTerminal }, { TERMINAL_GRANT, mintViewerTicket }] = await Promise.all([
        import("@/lib/terminal/instances"),
        import("@/lib/terminal/relay")
    ]);
    if (!reached || reached.standing !== "live" || reached.subjectType !== TERMINAL_GRANT)
        return { error: gone("guestLink.gone") };
    const limitKey = `terminal-link-open:${reached.grant.id}:${hashForLog(await clientIp()) ?? "unknown"}`;
    if (!(await rateLimit(limitKey, TERMINAL_OPEN_LIMIT, TERMINAL_OPEN_WINDOW_MS)).ok)
        return { error: account("terminals.errors.tooMany") };
    const terminal = await linkedTerminal(reached.subjectId);
    if (!terminal) return { error: gone("guestLink.gone") };
    if (!terminal.view.online) return { error: account("terminals.errors.offline") };
    // Each open is a use, as a camera's live view is: a counted link runs out
    // after that many, and the owner sees every one in the access log.
    if (!(await spendGrant(reached.grant))) return { error: gone("guestLink.gone") };
    await recordGrantUse({
        grantId: reached.grant.id,
        subjectType: TERMINAL_GRANT,
        subjectId: terminal.view.id,
        targetType: "terminalInstance",
        targetId: terminal.view.id,
        userId: null,
        linkNote: reached.note,
        action: "view",
        outcome: "done"
    }).catch((caught: unknown) => console.error("polaris: a terminal link use could not be logged:", caught));
    return {
        ticket: await mintViewerTicket(terminal.ownerId, terminal.view.id, reached.grant.id),
        access: "view"
    };
}
