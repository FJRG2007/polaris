/**
 * The unified Inbox: conversations across every connected channel, with live
 * polling. Any signed-in user sees and handles their own channels. The messaging
 * bridge (a managed container) runs the platform adapters; this page is a thin
 * client over the messaging service.
 */

import { requirePermission } from "@/lib/session";
import { bridgeConfigured } from "@/lib/messaging/bridge-client";
import { listChannels, listConversations } from "@/lib/messaging-service";
import { InboxView } from "./inbox-view";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
    const user = await requirePermission("inbox.read");
    const [ready, channels, conversations] = await Promise.all([
        bridgeConfigured(),
        listChannels(user.id),
        listConversations(user.id)
    ]);
    return (
        <InboxView
            initialChannels={channels}
            initialConversations={conversations}
            bridgeReady={ready}
        />
    );
}
