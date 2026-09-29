"use server";

/**
 * What Polaris keeps on the players' screens: the announcement pinned there and
 * the side panel. Whose call `{call.*}` reads is the chat the server is linked
 * to, chosen on its own screen (`chat-link-actions`).
 *
 * Taking a pinned announcement down is the same grant as sending one - the
 * console's. The panel is a setting of the server, so it is the manager's.
 */

import { z } from "zod";
import { gameWords, issueText } from "../game-words";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { linkedChannels, readChatLink } from "../../lib/minecraft/chat-link";
import { readPinned } from "../../lib/minecraft/pinned";
import { applySidebar, unpinAnnouncement } from "../../lib/minecraft/live-display-service";
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
import type { KnownValues } from "../../lib/minecraft/text-vars";

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
    /** Whether the server is linked to a chat with a call, which is what
     *  `{call.*}` reads. */
    readonly callLinked: boolean;
    /** The server's values that are settled while a text is written, for the
     *  counters: its name. */
    readonly known: KnownValues;
}

async function stateOf(installedAppId: string): Promise<LiveDisplayState> {
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true, catalogId: true, name: true }
    });
    const config = readInstallConfig(row?.config);
    const pinned = readPinned(config);
    const release = typeof config.mcRelease === "string" ? config.mcRelease : null;
    return {
        pinned: pinned ? { announcement: pinned.announcement, endsAt: pinned.endsAt } : null,
        sidebar: readSidebar(config),
        sidebarRefusal: sidebarRefusal(editionOf(row?.catalogId ?? "minecraft"), release),
        callLinked: linkedChannels(readChatLink(config)).call !== null,
        known: row?.name ? { "server.name": row.name } : {}
    };
}

export async function readLiveDisplayAction(
    installedAppId: string
): Promise<{ state?: LiveDisplayState; error?: string }> {
    const parsed = idSchema.safeParse(installedAppId);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.thatServerIsNotHere") };
    try {
        await requireGameServer("games.console", parsed.data);
        return { state: await stateOf(parsed.data) };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : (await gameWords("games"))("errors.thatCouldNotBeRead")
        };
    }
}

/** Take the pinned announcement off every screen now. */
export async function stopPinnedAction(
    installedAppId: string
): Promise<{ ok?: true; error?: string }> {
    const parsed = idSchema.safeParse(installedAppId);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.thatServerIsNotHere") };
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
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : (await gameWords("games"))("errors.theServerDidNotTake")
        };
    }
}

const sidebarInput = z.object({
    installedAppId: z.string().uuid(),
    sidebar: sidebarSchema
});

/** Save the side panel, and put it on screen (or take it off) straight away. */
export async function saveLiveDisplayAction(
    input: z.input<typeof sidebarInput>
): Promise<{ state?: LiveDisplayState; error?: string }> {
    const parsed = sidebarInput.safeParse(input);
    if (!parsed.success)
        return {
            error:
                (await issueText(parsed.error.issues[0]?.message)) ??
                (await gameWords("games"))("errors.checkThePanel")
        };
    const { installedAppId, sidebar } = parsed.data;
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        const current = await stateOf(installedAppId);
        if (hasSidebarProblems(sidebar, current.known)) {
            return { error: (await gameWords("games"))("errors.fixWhatIsMarkedOn") };
        }
        if (sidebar.enabled && current.sidebarRefusal) return { error: current.sidebarRefusal };
        await patchInstallConfig(installedAppId, { [SIDEBAR_KEY]: sidebar });
        await applySidebar(access.ownerId, installedAppId).catch(() => undefined);
        await recordAudit({
            actorId: user.id,
            action: "games.sidebar.save",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { enabled: sidebar.enabled, lines: sidebar.lines.length }
        });
        return { state: await stateOf(installedAppId) };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : (await gameWords("games"))("errors.thatCouldNotBeSaved")
        };
    }
}
