/**
 * The gate in front of a meeting's guest link (/m/<token>).
 *
 * The same order every public link in Polaris uses: exists, address rules,
 * fraud check, then the password. Expiry and a cap are not asked for: the link
 * already dies with the call (`end` clears the token), and a meeting caps its
 * own room. The page runs this before it names the meeting, and both joins on
 * the link run it again before a seat is made.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { ChatAccessError } from "./access";
import { clientIp } from "@/lib/request-context";
import { dymoIpAllowed } from "@/lib/dymo-service";
import { linkLimitColumns } from "@/lib/link-limits";
import { verifyLinkPassword } from "@polaris/core/link-password";
import {
    checkLink,
    readAddressRules,
    signUnlock,
    unlockCookieName,
    verifyUnlock
} from "@/lib/link-guards";

/** The unlock-cookie namespace meeting links are signed under. */
const MEETING_LINK_SCOPE = "meeting";

/** What a host may set on the guest link: the shared limits without the expiry
 *  and the cap, which the call already decides. */
export const meetingLinkLimitsSchema = core.linkLimitsSchema.omit({ maxViews: true, expiresAt: true });

export type MeetingLinkLimitsInput = z.infer<typeof meetingLinkLimitsSchema>;

export interface MeetingLinkLimitsView {
    readonly hasPassword: boolean;
    readonly allowedCidrs: string[];
    readonly allowedCountries: string[];
    readonly allowedContinents: string[];
}

export type MeetingLinkGate =
    | { readonly ok: true; readonly meetingId: string }
    | { readonly ok: false; readonly reason: string };

export function meetingUnlockCookie(meetingId: string): string {
    return unlockCookieName(MEETING_LINK_SCOPE, meetingId);
}

export function signMeetingUnlock(meetingId: string, passwordHash: string | null): string {
    return signUnlock(MEETING_LINK_SCOPE, meetingId, { passwordHash }, loadEnv().POLARIS_AUTH_SECRET);
}

/** Resolve a guest token and decide whether it opens anything. An ended call
 *  answers not_found, as one that never existed does. */
export async function gateMeetingLink(token: string): Promise<MeetingLinkGate> {
    if (!token) return { ok: false, reason: "not_found" };
    const meeting = await prisma.meeting.findUnique({
        where: { guestToken: token },
        select: {
            id: true,
            endedAt: true,
            linkPasswordHash: true,
            allowedCidrs: true,
            allowedCountries: true,
            allowedContinents: true
        }
    });
    if (!meeting || meeting.endedAt) return { ok: false, reason: "not_found" };

    const ip = await clientIp();
    const checked = await checkLink(
        { limits: { revokedAt: null, expiresAt: null, maxUses: null, useCount: 0 }, rules: meeting },
        ip
    );
    if (!checked.ok) return { ok: false, reason: checked.reason };

    // Fraud check. A no-op unless the integration is on, and it fails open.
    if (!(await dymoIpAllowed(ip)).allowed) return { ok: false, reason: "ip_flagged" };

    if (meeting.linkPasswordHash) {
        const solved = (await cookies()).get(meetingUnlockCookie(meeting.id))?.value;
        const grant = { passwordHash: meeting.linkPasswordHash };
        if (!verifyUnlock(MEETING_LINK_SCOPE, meeting.id, solved, grant, loadEnv().POLARIS_AUTH_SECRET)) {
            return { ok: false, reason: "password_required" };
        }
    }

    return { ok: true, meetingId: meeting.id };
}

/** The meeting a password is being typed for, when its link still opens.
 *  Unknown and unusable answer the same null. */
export async function meetingLinkForUnlock(
    token: string
): Promise<{ readonly id: string; readonly passwordHash: string | null } | null> {
    const gate = await gateMeetingLink(token);
    if (!gate.ok && gate.reason !== "password_required") return null;
    const meeting = await prisma.meeting.findUnique({
        where: { guestToken: token },
        select: { id: true, linkPasswordHash: true }
    });
    return meeting ? { id: meeting.id, passwordHash: meeting.linkPasswordHash } : null;
}

/** Whether a password opens this link. Wrong and unset both answer false. */
export async function meetingLinkPasswordMatches(
    meeting: { readonly passwordHash: string | null },
    password: string
): Promise<boolean> {
    return meeting.passwordHash ? verifyLinkPassword(password, meeting.passwordHash) : false;
}

/** The host's own meeting, or a refusal: the link's limits are the host's to
 *  read and set, as opening the link is. */
async function hostedMeeting(actorId: string, meetingId: string) {
    const meeting = await prisma.meeting.findUnique({
        where: { id: meetingId },
        select: {
            hostId: true,
            linkPasswordHash: true,
            allowedCidrs: true,
            allowedCountries: true,
            allowedContinents: true
        }
    });
    if (!meeting || meeting.hostId !== actorId) {
        throw new ChatAccessError({ key: "errors.callShareStarterOnly" });
    }
    return meeting;
}

function toView(meeting: {
    linkPasswordHash: string | null;
    allowedCidrs: string;
    allowedCountries: string;
    allowedContinents: string;
}): MeetingLinkLimitsView {
    return { hasPassword: Boolean(meeting.linkPasswordHash), ...readAddressRules(meeting) };
}

export async function getMeetingLinkLimits(actorId: string, meetingId: string): Promise<MeetingLinkLimitsView> {
    return toView(await hostedMeeting(actorId, meetingId));
}

export async function setMeetingLinkLimits(
    actorId: string,
    meetingId: string,
    input: MeetingLinkLimitsInput
): Promise<MeetingLinkLimitsView> {
    await hostedMeeting(actorId, meetingId);
    const columns = await linkLimitColumns({ ...input, expiresAt: null, maxViews: null });
    const saved = await prisma.meeting.update({
        where: { id: meetingId },
        data: {
            allowedCidrs: columns.allowedCidrs,
            allowedCountries: columns.allowedCountries,
            allowedContinents: columns.allowedContinents,
            ...("passwordHash" in columns ? { linkPasswordHash: columns.passwordHash } : {})
        },
        select: {
            linkPasswordHash: true,
            allowedCidrs: true,
            allowedCountries: true,
            allowedContinents: true
        }
    });
    return toView(saved);
}
