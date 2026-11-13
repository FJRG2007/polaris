"use server";

import { requirePermission } from "@/lib/session";
import { installRef } from "@/lib/apps/install-access";
import { resourceAccess } from "@/lib/resource-access";
import { bridgeConfigured } from "@/lib/messaging/bridge-client";
import { bridgeInstallId } from "@/lib/messaging/bridge-endpoint";
import { listChannels } from "@/lib/messaging-service";

export async function loadChannelsAction() {
    const user = await requirePermission("inbox.read");
    return { channels: await listChannels(user.id) };
}

/**
 * Which connect screen to show: the channel picker once the bridge answers,
 * otherwise the way to the bridge app - or, with no bridge installed at all,
 * the Email & SMS screen.
 */
export async function loadConnectChannelAction() {
    const user = await requirePermission("inbox.read");
    if (await bridgeConfigured()) return { screen: "ready" as const };
    const installId = await bridgeInstallId();
    if (!installId) return { screen: "moved" as const, to: "/admin/email" };
    const canOpen = await resourceAccess(user, installRef(installId), "deploy.read");
    return {
        screen: "bridge" as const,
        bridgeHref: canOpen ? `/apps/installed/${installId}` : null
    };
}
