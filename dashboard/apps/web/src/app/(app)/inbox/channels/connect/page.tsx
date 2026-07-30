/**
 * The channel marketplace: every way Polaris can be connected to something, in
 * one place. Messaging channels and email senders are both listed here because
 * an operator looking for "how do I connect X" should not have to know which of
 * the two X happens to be.
 */

import { requireUser } from "@/lib/session";
import { bridgeConfigured } from "@/lib/messaging/bridge-client";
import { ConnectChannelView } from "./connect-view";

export const dynamic = "force-dynamic";

export default async function ConnectChannelPage() {
    await requireUser();
    return <ConnectChannelView bridgeReady={await bridgeConfigured()} />;
}
