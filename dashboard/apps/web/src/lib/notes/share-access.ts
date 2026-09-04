/**
 * The gate in front of a published note.
 *
 * One place, for the same reason the snippet gate is one place: the page is not
 * the only thing a token reaches, and the moment there are two entrances there
 * are two chances for one of them to forget the password. Anything that serves a
 * published note asks this first.
 *
 * The order is the one every public link in Polaris uses: exists, still usable,
 * address rules, fraud check, then the password. Each refusal comes back as a
 * word rather than a sentence, so the caller decides what a visitor is told - and
 * what they are told is the same whatever the reason, because a page that
 * distinguishes "never existed" from "expired" answers a question somebody
 * probing links wanted answered.
 */

import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { clientIp } from "@/lib/request-context";
import { dymoIpAllowed } from "@/lib/dymo-service";
import { linkAddressDenial } from "@/lib/link-guards";
import {
    noteShareUsability,
    noteUnlockCookie,
    resolveNoteShareByToken,
    verifyNoteUnlock,
    type NoteShareRecord
} from "@/lib/notes/share-service";

export type NoteShareGate =
    | { ok: true; share: NoteShareRecord; }
    | { ok: false; status: number; reason: string; };

/** Why a gate refused, in words a visitor can act on. */
export const NOTE_DENIAL_MESSAGES: Readonly<Record<string, string>> = {
    not_found: "This link does not exist or has been removed.",
    revoked: "This link has been revoked.",
    expired: "This link has expired.",
    exhausted: "This link has already been opened as many times as it allows.",
    scheduled: "This link is not open yet.",
    ip_not_allowed: "This link is not available from your network.",
    country_not_allowed: "This link is not available from your location.",
    ip_flagged: "This link is not available from your network.",
    password_required: "This link is protected."
};

export function noteDenialMessage(reason: string): string {
    return NOTE_DENIAL_MESSAGES[reason] ?? "This link is not available.";
}

export async function gateNoteShareRequest(token: string): Promise<NoteShareGate> {
    const share = await resolveNoteShareByToken(token);
    if (!share) return { ok: false, status: 404, reason: "not_found" };

    const usable = noteShareUsability(share);
    if (!usable.ok) return { ok: false, status: 410, reason: usable.reason };

    const ip = await clientIp();
    const address = await linkAddressDenial(share, ip);
    if (address) return { ok: false, status: 403, reason: address };

    // Fraud check. A no-op unless the integration is on, and it fails open.
    if (!(await dymoIpAllowed(ip)).allowed) return { ok: false, status: 403, reason: "ip_flagged" };

    if (share.passwordHash) {
        const solved = (await cookies()).get(noteUnlockCookie(share.id))?.value;
        if (!verifyNoteUnlock(share.id, solved, loadEnv().POLARIS_AUTH_SECRET)) {
            return { ok: false, status: 401, reason: "password_required" };
        }
    }

    return { ok: true, share };
}
