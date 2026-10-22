/**
 * The channel marketplace: every messaging platform the Inbox can be connected
 * to. Email and SMS senders are added under Email & SMS.
 *
 * Every platform here runs on the messaging bridge. Without one installed there
 * is nothing to connect, so the page sends you to the senders that work without
 * it; with one installed but stopped, the view says so and links to the bridge
 * for a viewer who can open it.
 */

import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { installRef } from "@/lib/apps/install-access";
import { resourceAccess } from "@/lib/resource-access";
import { bridgeConfigured } from "@/lib/messaging/bridge-client";
import { bridgeInstallId } from "@/lib/messaging/bridge-endpoint";
import { ConnectChannelView } from "./connect-view";

export const dynamic = "force-dynamic";

export default async function ConnectChannelPage() {
    const user = await requirePermission("inbox.read");
    if (await bridgeConfigured()) return <ConnectChannelView bridgeReady />;
    const installId = await bridgeInstallId();
    if (!installId) redirect("/admin/email");
    const canOpen = await resourceAccess(user, installRef(installId), "deploy.read");
    return (
        <ConnectChannelView
            bridgeReady={false}
            bridgeHref={canOpen ? `/apps/installed/${installId}` : undefined}
        />
    );
}
