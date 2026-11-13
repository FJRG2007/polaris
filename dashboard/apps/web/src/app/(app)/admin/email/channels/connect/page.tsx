/**
 * The channel marketplace: every messaging platform alerts, notices and sign-in
 * codes can go out through. Polaris connects them itself, so the picker needs no
 * data and paints at once. Email and SMS senders are added under Email & SMS.
 */

import { requirePermission, sessionCan } from "@/lib/session";
import { ConnectChannelView } from "@/app/(app)/admin/email/channels/connect/connect-view";

export const dynamic = "force-dynamic";

export default async function ConnectChannelPage() {
    const user = await requirePermission("inbox.read");
    // Not awaited: the grid paints now and its cards unlock when the answer lands.
    return <ConnectChannelView canManage={sessionCan(user, "inbox.manage")} />;
}
