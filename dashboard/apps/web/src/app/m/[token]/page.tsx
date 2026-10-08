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
import { Messages } from "@/components/i18n/messages";
import { getTranslations } from "@/lib/i18n/request";
import { LinkUnavailable } from "@/components/public-shell";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function GuestMeetingPage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    const session = await getSession();
    const t = await getTranslations("chat");

    const meeting = await prisma.meeting.findUnique({
        where: { guestToken: token },
        select: { id: true, endedAt: true, title: true, requireAccount: true }
    });

    if (!meeting || meeting.endedAt) {
        return (
            <LinkUnavailable
                signedIn={Boolean(session?.user)}
                title={t("guestCall.unavailableTitle")}
                message={t("guestCall.unavailable")}
            />
        );
    }

    // The host asked for accounts, and nobody is signed in here.
    //
    // Said now rather than at the join: the honest thing is to say so before
    // somebody types a name that was never going to be accepted. The link still
    // names the meeting, which is how somebody knows what they are being asked to
    // sign in for - and once they are, this same address seats them under their
    // own name instead of a typed one.
    if (meeting.requireAccount && !session?.user) {
        return (
            <LinkUnavailable
                signedIn={false}
                title={meeting.title || t("guestCall.meeting")}
                message={t("guestCall.accountOnly")}
            />
        );
    }

    return (
        <Messages namespaces={["chat", "shortcuts"]}>
            <GuestCall
                token={token}
                title={meeting.title}
                signedIn={Boolean(session?.user)}
                suggestedName={session?.user?.name ?? ""}
                // Whose name they arrive under. A meeting that asked for accounts
                // seats whoever is signed in as themselves - there is nothing to
                // type, and nothing they could type that would be believed.
                asAccount={meeting.requireAccount}
            />
        </Messages>
    );
}
