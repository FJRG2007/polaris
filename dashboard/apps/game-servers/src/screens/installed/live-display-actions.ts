"use server";

/**
 * What Polaris keeps on the players' screens: the announcement pinned there, the
 * side panel, and the chat group whose call `{call.*}` reads.
 *
 * Taking a pinned announcement down is the same grant as sending one - the
 * console's. The panel and the chat group are settings of the server, so they
 * are the manager's.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { CALL_GROUP_KEY, readCallGroup } from "../../lib/minecraft/live-values";
import {
    readPinned,
    applySidebar,
    unpinAnnouncement
} from "../../lib/minecraft/live-display-service";
import {
    SIDEBAR_KEY,
    hasSidebarProblems,
    readSidebar,
    sidebarRefusal,
    sidebarSchema,
    type SidebarConfig
} from "../../lib/minecraft/sidebar";
import { editionOf } from "../../lib/minecraft/service";
import type { Announcement } from "../../lib/minecraft/announcement";

const { recordAudit } = host.auditService;
const { requireGameServer } = host.appsInstallAccess;
const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;

const idSchema = z.string().uuid();

/** What the Announce and side panel screens draw from. */
export interface LiveDisplayState {
    readonly pinned: { readonly announcement: Announcement; readonly endsAt: number | null } | null;
    readonly sidebar: SidebarConfig;
    /** Why this server cannot have a panel, or null. */
    readonly sidebarRefusal: string | null;
    readonly callGroupId: string | null;
    /** The chat groups the viewer is in, to choose the one whose call is read. */
    readonly groups: readonly { readonly id: string; readonly name: string }[];
}

async function stateOf(installedAppId: string, viewerId: string): Promise<LiveDisplayState> {
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true, catalogId: true }
    });
    const config = readInstallConfig(row?.config);
    const pinned = readPinned(config);
    const release = typeof config.mcRelease === "string" ? config.mcRelease : null;
    const memberships = await prisma.chatChannelMember.findMany({
        where: { userId: viewerId, channel: { kind: "group" } },
        select: { channel: { select: { id: true, name: true } } },
        take: 200
    });
    return {
        pinned: pinned ? { announcement: pinned.announcement, endsAt: pinned.endsAt } : null,
        sidebar: readSidebar(config),
        sidebarRefusal: sidebarRefusal(editionOf(row?.catalogId ?? "minecraft"), release),
        callGroupId: readCallGroup(config),
        groups: memberships
            .map((one) => ({ id: one.channel.id, name: one.channel.name || "Unnamed group" }))
            .sort((left, right) => left.name.localeCompare(right.name))
    };
}

export async function readLiveDisplayAction(
    installedAppId: string
): Promise<{ state?: LiveDisplayState; error?: string }> {
    const parsed = idSchema.safeParse(installedAppId);
    if (!parsed.success) return { error: "That server is not here" };
    try {
        const { user } = await requireGameServer("games.console", parsed.data);
        return { state: await stateOf(parsed.data, user.id) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "That could not be read" };
    }
}

/** Take the pinned announcement off every screen now. */
export async function stopPinnedAction(
    installedAppId: string
): Promise<{ ok?: true; error?: string }> {
    const parsed = idSchema.safeParse(installedAppId);
    if (!parsed.success) return { error: "That server is not here" };
    try {
        const { user, access } = await requireGameServer("games.console", parsed.data);
        await unpinAnnouncement(access.ownerId, parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "games.announce.stop",
            targetType: "installedApp",
            targetId: parsed.data
        });
        return { ok: true };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "The server did not take that" };
    }
}

const sidebarInput = z.object({
    installedAppId: z.string().uuid(),
    sidebar: sidebarSchema,
    callGroupId: z.string().uuid().nullable()
});

/** Save the side panel and the chat group, and put the panel on screen (or take
 *  it off) straight away. */
export async function saveLiveDisplayAction(
    input: z.input<typeof sidebarInput>
): Promise<{ state?: LiveDisplayState; error?: string }> {
    const parsed = sidebarInput.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the panel" };
    const { installedAppId, sidebar, callGroupId } = parsed.data;
    if (hasSidebarProblems(sidebar)) return { error: "Fix what is marked on the panel first" };
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        // Only a group the person choosing it is in: otherwise this would be a way
        // to read who is in a call nobody let them see.
        if (callGroupId) {
            const member = await prisma.chatChannelMember.count({
                where: { userId: user.id, channelId: callGroupId, channel: { kind: "group" } }
            });
            if (member === 0) return { error: "Choose a group you are in" };
        }
        const current = await stateOf(installedAppId, user.id);
        if (sidebar.enabled && current.sidebarRefusal) return { error: current.sidebarRefusal };
        await patchInstallConfig(installedAppId, {
            [SIDEBAR_KEY]: sidebar,
            [CALL_GROUP_KEY]: callGroupId
        });
        await applySidebar(access.ownerId, installedAppId).catch(() => undefined);
        await recordAudit({
            actorId: user.id,
            action: "games.sidebar.save",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { enabled: sidebar.enabled, lines: sidebar.lines.length }
        });
        return { state: await stateOf(installedAppId, user.id) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "That could not be saved" };
    }
}
