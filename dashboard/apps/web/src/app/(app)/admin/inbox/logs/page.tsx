/**
 * Messaging logs: recent inbound/outbound message activity across every channel,
 * so an operator can see what the bridge is sending and receiving and its delivery
 * state - useful for confirming a channel works end to end.
 */

import { requirePermission } from "@/lib/session";
import { listMessagingActivity } from "@/lib/messaging-service";
import { LogsView } from "./logs-view";

export const dynamic = "force-dynamic";

export default async function LogsPage() {
    const user = await requirePermission("inbox.read");
    const activity = await listMessagingActivity(user.id);
    return <LogsView initialActivity={activity} />;
}
