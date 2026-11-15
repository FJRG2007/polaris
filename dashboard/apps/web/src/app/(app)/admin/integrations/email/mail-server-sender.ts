"use server";

/**
 * Where Polaris's own mail server stands, for the "Polaris mail server" choice in
 * the Add sender dialog.
 *
 * A server's setup creates its sender itself (the `sender` step), so the dialog
 * never asks for a host or a password: it only needs to know whether the app is
 * on, whether a server exists, and whether that server already sends. Turning the
 * app on and creating the sender on a ready server are the mail server's own
 * actions (`installMailServerAppAction`, `resumeSetupAction`), called from the
 * dialog as they are from the mail server screens.
 */

import { prisma } from "@polaris/db";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { requirePermission, sessionCan } from "@/lib/session";
import { mailServerAppInstalled } from "@/lib/mail-server/app-install";
import { listServers, MailServerAccessError } from "@/lib/mail-server/access";

interface ServerRef {
    readonly serverId: string;
    readonly hostname: string;
}

export type PolarisMailState =
    | { readonly kind: "forbidden" }
    | { readonly kind: "not-installed"; readonly canInstall: boolean }
    | { readonly kind: "no-server" }
    | ({ readonly kind: "setting-up" | "failed" | "ready" } & ServerRef)
    | ({ readonly kind: "sending"; readonly channelName: string } & ServerRef);

export async function polarisMailStateAction(): Promise<PolarisMailState> {
    const user = await requirePermission("inbox.manage");
    if (!(await sessionCan(user, "mailserver.manage"))) return { kind: "forbidden" };
    if (!(await mailServerAppInstalled())) return { kind: "not-installed", canInstall: user.isAdmin };
    let servers;
    try {
        servers = await listServers({ id: user.id, isAdmin: user.isAdmin }, await scopeOrgIdFor(user.id));
    } catch (error) {
        if (error instanceof MailServerAccessError) return { kind: "forbidden" };
        throw error;
    }
    if (servers.length === 0) return { kind: "no-server" };

    // A server's channel can be removed from the senders list while the server
    // keeps its id, so the id alone does not mean it still sends.
    const channelIds = servers.flatMap((server) => (server.channelId ? [server.channelId] : []));
    const channels =
        channelIds.length > 0
            ? await prisma.channel.findMany({
                  where: { id: { in: channelIds } },
                  select: { id: true, name: true }
              })
            : [];
    const names = new Map(channels.map((channel) => [channel.id, channel.name]));
    const ref = (server: (typeof servers)[number]): ServerRef => ({
        serverId: server.id,
        hostname: server.hostname
    });

    const sending = servers.find((server) => server.channelId && names.has(server.channelId));
    if (sending) return { kind: "sending", channelName: names.get(sending.channelId ?? "") ?? "", ...ref(sending) };
    for (const kind of ["ready", "setting-up", "failed"] as const) {
        const server = servers.find((row) => row.status === kind);
        if (server) return { kind, ...ref(server) };
    }
    return { kind: "setting-up", ...ref(servers[0]!) };
}
