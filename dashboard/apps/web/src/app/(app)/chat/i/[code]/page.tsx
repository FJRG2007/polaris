/**
 * Somebody followed an invitation.
 *
 * Inside the authenticated shell on purpose: joining a space is something an
 * account does, so an invitation opened by a browser with no session lands on
 * sign-in and comes back here afterwards, which is the behaviour anybody who has
 * ever been sent a link expects.
 *
 * The offer is read on the server so the space's name is in the first paint -
 * being asked to accept something that has not said what it is yet is the one
 * thing this screen must never do.
 */

import { InviteView } from "./invite-view";

export const dynamic = "force-dynamic";

export default async function ChatInvitePage({
    params
}: {
    params: Promise<{ code: string }>;
}) {
    const { code } = await params;
    return <InviteView code={code} />;
}
