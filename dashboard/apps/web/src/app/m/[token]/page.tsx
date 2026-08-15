/**
 * Joining a call without an account (/m/<token>).
 *
 * Outside the dashboard shell entirely: whoever opens this has no session, no
 * app to be shown, and no reason to be asked for one. What they get is the same
 * public frame every share link uses, a field for their name, and then the call.
 *
 * The token is the whole credential and an account holder created it
 * deliberately, so the page does not ask for anything else. What it does not do
 * is say why a link failed - expired, ended, never existed all give the same
 * answer, because distinguishing them answers a question somebody probing links
 * wanted answered.
 */

import { prisma } from "@polaris/db";
import { GuestCall } from "./guest-call";
import { getSession } from "@/lib/session";
import { LinkUnavailable } from "@/components/public-shell";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function GuestMeetingPage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    const session = await getSession();

    const meeting = await prisma.meeting.findUnique({
        where: { guestToken: token },
        select: { id: true, endedAt: true, title: true }
    });

    if (!meeting || meeting.endedAt) {
        return (
            <LinkUnavailable
                signedIn={Boolean(session?.user)}
                title="Call unavailable"
                message="This call has ended, or the link is no longer good."
            />
        );
    }

    return (
        <GuestCall
            token={token}
            title={meeting.title}
            signedIn={Boolean(session?.user)}
            suggestedName={session?.user?.name ?? ""}
        />
    );
}
