"use server";

/**
 * What somebody with a link, and no account, is allowed to do.
 *
 * Two writes, and neither of them takes a session - that is the whole point of a
 * link. So both are narrowed by the token instead: solving the password, and
 * spending the opening that turns a resolved link into a pass this browser
 * carries.
 *
 * The password check is rate-limited per link per address, because a link with a
 * password is the one thing here that can be guessed at, and it is the only
 * guessing an outsider can do at all.
 */

import * as core from "@polaris/core";
import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import * as links from "@/lib/office/links";
import { getTranslations } from "@/lib/i18n/request";
import { clientIp, hashForLog } from "@/lib/request-context";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";

/** How many wrong passwords a link takes from one address before it stops
 *  answering, and for how long. The same numbers the note shares use. */
const UNLOCK_LIMIT = 8;
const UNLOCK_WINDOW_MS = 10 * 60_000;

/** How long a solved password is remembered. Half a day: long enough to read
 *  something and come back to it, short enough that a shared machine does not
 *  carry it into next week. */
const UNLOCK_MAX_AGE = 60 * 60 * 12;

/** How long a pass to one document lasts. The same, for the same reason. */
const PASS_MAX_AGE = 60 * 60 * 12;

/**
 * Solve a link's password.
 *
 * Answers the same way for a token that names nothing and one that is no longer
 * usable: telling them apart would say which tokens are real.
 */
export async function unlockOfficeLinkAction(
    token: string,
    password: string
): Promise<{ error?: string }> {
    const t = await getTranslations("publicPages");
    const visit = await links.resolveLink(token);
    if (!visit || visit.refusal) return { error: t("office.unavailable") };

    const parsed = core.officeLinkUnlockSchema.safeParse({ password });
    if (!parsed.success) return { error: t("office.typePassword") };

    const limitKey = `office-unlock:${visit.linkId}:${hashForLog(await clientIp()) ?? "unknown"}`;
    if (!(await rateLimit(limitKey, UNLOCK_LIMIT, UNLOCK_WINDOW_MS)).ok) {
        return { error: t("office.tooMany") };
    }
    if (!(await links.linkPasswordMatches(visit.linkId, parsed.data.password))) {
        return { error: t("office.wrongPassword") };
    }

    await resetRateLimit(limitKey);
    const env = loadEnv();
    const unlock = links.signLinkUnlock(visit.linkId, visit.passwordHash);
    (await cookies()).set(links.linkUnlockCookie(visit.linkId), unlock, {
        httpOnly: true,
        sameSite: "lax",
        secure: env.POLARIS_SECURE_COOKIES,
        path: "/",
        maxAge: UNLOCK_MAX_AGE
    });
    return {};
}

/**
 * Spend one opening and hand this browser a pass to the document.
 *
 * The pass is what the content and stream routes read, and it is named per
 * document rather than per link so those routes answer "may this browser write
 * here" without a lookup on every keystroke. The role is inside the signature
 * rather than beside it, so a viewer cannot promote their own cookie.
 *
 * Called once, when the page opens. Everything after that is the pass.
 */
export async function openOfficeLinkAction(
    token: string
): Promise<{ ok: true; role: core.OfficeRole } | { error: string }> {
    const t = await getTranslations("publicPages");
    const visit = await links.resolveLink(token);
    if (!visit || visit.refusal) return { error: t("office.unavailable") };

    if (visit.needsPassword) {
        const solved = (await cookies()).get(links.linkUnlockCookie(visit.linkId))?.value;
        if (!links.linkUnlocked(visit.linkId, visit.passwordHash, solved)) {
            return { error: t("office.unavailable") };
        }
    }

    // Bounded in the statement, so two people arriving together on the last
    // opening cannot both be let in.
    if (!(await links.spendLink(visit.linkId))) {
        return { error: t("office.denied.exhausted") };
    }

    const env = loadEnv();
    (await cookies()).set(
        links.linkPassCookie(visit.documentId),
        links.signLinkPass(visit.documentId, visit.linkId, visit.role, visit.passwordHash),
        {
            httpOnly: true,
            sameSite: "lax",
            secure: env.POLARIS_SECURE_COOKIES,
            path: "/",
            maxAge: PASS_MAX_AGE
        }
    );
    return { ok: true, role: visit.role };
}
