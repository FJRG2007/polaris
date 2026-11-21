/**
 * The group invitations waiting on this reader (/chat/invites): what somebody's
 * "who can add me to groups" turned from an add into a question. The shell draws
 * at once; the list is read by the client.
 */

import { InvitesView } from "./invites-view";

export const dynamic = "force-dynamic";

export default function InvitesPage() {
    return <InvitesView />;
}
