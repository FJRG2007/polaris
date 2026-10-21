/**
 * The channel marketplace: every messaging platform the Inbox can be connected
 * to. Email and SMS senders are added under Email & SMS.
 *
 * Every platform here runs on the messaging bridge. Without one installed there
 * is nothing to connect, so the page sends you to the senders that work without
 * it; with one installed but stopped, the view says so and links to the bridge.
 */

import { redirect } from "next/navigation";
import { prisma } from "@polaris/db";
import { requirePermission } from "@/lib/session";
import { bridgeConfigured } from "@/lib/messaging/bridge-client";
import { ConnectChannelView } from "./connect-view";

export const dynamic = "force-dynamic";

export default async function ConnectChannelPage() {
    await requirePermission("inbox.read");
    if (await bridgeConfigured()) return <ConnectChannelView bridgeReady />;
    const install = await prisma.installedApp.findFirst({
        where: { catalogId: "messaging-bridge", status: { not: "removed" } },
        orderBy: { createdAt: "desc" },
        select: { id: true }
    });
    if (!install) redirect("/admin/email");
    return <ConnectChannelView bridgeReady={false} bridgeHref={`/apps/installed/${install.id}`} />;
}
