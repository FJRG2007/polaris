/**
 * The channel marketplace: every messaging platform the Inbox can be connected
 * to. Email and SMS senders are added under Email & SMS.
 */

import { requirePermission } from "@/lib/session";
import { bridgeConfigured } from "@/lib/messaging/bridge-client";
import { ConnectChannelView } from "./connect-view";

export const dynamic = "force-dynamic";

export default async function ConnectChannelPage() {
    await requirePermission("inbox.read");
    return <ConnectChannelView bridgeReady={await bridgeConfigured()} />;
}
