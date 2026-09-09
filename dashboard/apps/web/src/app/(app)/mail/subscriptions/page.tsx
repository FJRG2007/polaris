/**
 * Everything sending you mail you could stop.
 *
 * The screen exists because the way out of a mailing list is at the bottom of
 * one message, in six-point grey, and there is no way to see them all at once -
 * so people unsubscribe from the newsletter in front of them and never from the
 * forty they stopped reading two years ago.
 *
 * One read of the registry the sync fills in as mail arrives. Nothing is fetched
 * from a mail server to draw this.
 */

import { requirePermission } from "@/lib/session";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { SubscriptionsView } from "./subscriptions-view";
import { MOST_SUBSCRIPTIONS, listSubscriptions } from "@/lib/mailbox/subscriptions";

export const dynamic = "force-dynamic";

export default async function MailSubscriptionsPage() {
    const user = await requirePermission("mail.use");
    const subscriptions = await listSubscriptions(user.id, await scopeOrgIdFor(user.id));
    return (
        <SubscriptionsView
            subscriptions={subscriptions}
            capped={subscriptions.length >= MOST_SUBSCRIPTIONS}
        />
    );
}
