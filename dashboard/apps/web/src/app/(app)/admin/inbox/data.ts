"use server";

import { requirePermission } from "@/lib/session";
import { installRef } from "@/lib/apps/install-access";
import { resourceAccess } from "@/lib/resource-access";
import { bridgeConfigured } from "@/lib/messaging/bridge-client";
import { bridgeInstallId } from "@/lib/messaging/bridge-endpoint";
import {
    listChannels,
    listContacts,
    listConversations,
    listMessagingActivity
} from "@/lib/messaging-service";

/** The inbox: its channels, its conversations, and whether the bridge answers. */
export async function loadInboxAction() {
    const user = await requirePermission("inbox.read");
    const [ready, channels, conversations] = await Promise.all([
        bridgeConfigured(),
        listChannels(user.id),
        listConversations(user.id)
    ]);
    return { ready, channels, conversations };
}

export async function loadInboxChannelsAction() {
    const user = await requirePermission("inbox.read");
    return { channels: await listChannels(user.id) };
}

export async function loadInboxContactsAction() {
    const user = await requirePermission("inbox.read");
    return { contacts: await listContacts(user.id) };
}

export async function loadInboxLogsAction() {
    const user = await requirePermission("inbox.read");
    return { activity: await listMessagingActivity(user.id) };
}

/**
 * Which connect screen to show: the channel picker once the bridge answers,
 * otherwise the way to the bridge app - or, with no bridge installed at all,
 * the email screen, where the inbox is set up.
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
