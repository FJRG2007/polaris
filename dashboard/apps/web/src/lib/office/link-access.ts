/**
 * Every gate a document link goes through, in one order.
 *
 * The same order a note share, a Drive share, a drop point and a snippet use,
 * because they are the same gates - does the token name anything, is it still
 * usable, is the caller's address allowed here, has the password been solved.
 * Written once per app rather than once per route, so a new route cannot skip
 * the third one by forgetting it existed.
 *
 * A token that names nothing gets the same answer as one that expired. Anything
 * else turns the URL into a way of finding out which tokens are real.
 */

import { cookies } from "next/headers";
import { clientIp } from "@/lib/request-context";
import * as links from "@/lib/office/links";
import { getTranslations } from "@/lib/i18n/request";
import { dymoIpAllowed } from "@/lib/dymo-service";

/** Why a link would not open, in the words the screen turns into a sentence. */
export type OfficeLinkDenial =
    | "not_found"
    | "revoked"
    | "expired"
    | "exhausted"
    | "scheduled"
    | "ip_flagged"
    | "password_required";

export type OfficeLinkGate =
    | { readonly ok: true; readonly visit: links.LinkVisit }
    | { readonly ok: false; readonly status: number; readonly reason: OfficeLinkDenial };

/**
 * Resolve a token and decide whether it opens anything.
 *
 * Deliberately does NOT count a use. Looking is not using, and spending one to
 * draw a password form would make a link worth three openings worth one.
 */
export async function gateOfficeLink(token: string): Promise<OfficeLinkGate> {
    const visit = await links.resolveLink(token);
    if (!visit) return { ok: false, status: 404, reason: "not_found" };
    // `unknown` is what the shared usability reader says when it cannot place a
    // reason. It means the same thing here as every other refusal does from
    // outside - the link does not work - and is folded in rather than leaking a
    // word nobody wrote a sentence for.
    if (visit.refusal) {
        return {
            ok: false,
            status: 410,
            reason: visit.refusal === "unknown" ? "not_found" : visit.refusal
        };
    }

    // Fraud check. A no-op unless the integration is on, and it fails open: an
    // outage at somebody else's service must not close everybody's links.
    if (!(await dymoIpAllowed(await clientIp())).allowed) {
        return { ok: false, status: 403, reason: "ip_flagged" };
    }

    if (visit.needsPassword) {
        const solved = (await cookies()).get(links.linkUnlockCookie(visit.linkId))?.value;
        if (!links.linkUnlocked(visit.linkId, visit.passwordHash, solved)) {
            return { ok: false, status: 401, reason: "password_required" };
        }
    }

    return { ok: true, visit };
}

/** What to put on the card. Never why in detail: "this link no longer works" is
 *  the honest answer to every one of these from outside. */
export async function officeLinkDenial(reason: OfficeLinkDenial): Promise<string> {
    const t = await getTranslations("publicPages");
    switch (reason) {
        case "expired":
            return t("office.denied.expired");
        case "exhausted":
            return t("office.denied.exhausted");
        case "revoked":
            return t("office.denied.revoked");
        case "scheduled":
            return t("office.denied.scheduled");
        case "ip_flagged":
            return t("office.denied.flagged");
        default:
            return t("office.denied.other");
    }
}
