"use server";

/**
 * The Moderation tab: what the server's mods announce to players, and the
 * switch that lets one of them through.
 *
 * Reading is the moderators', like the tab; letting an announcement through
 * edits a file on the server, so it is the managers'.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import { gameWords, messageText } from "../game-words";
import * as announcements from "../../lib/minecraft/mod-announcements-service";

const { recordAudit } = host.auditService;
const { requireGameServer } = host.appsInstallAccess;

const serverId = z.string().uuid();

const failure = async (caught: unknown, fallback: string): Promise<string> =>
    caught instanceof Error ? await messageText(caught.message) : fallback;

export async function readAnnouncementsAction(
    installedAppId: string
): Promise<{ state?: announcements.AnnouncementsState; error?: string }> {
    const words = await gameWords("minecraft");
    const parsed = serverId.safeParse(installedAppId);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.serverNotFound") };
    try {
        const { access } = await requireGameServer("games.moderate", parsed.data);
        return { state: await announcements.announcementsState(access.ownerId, parsed.data) };
    } catch (caught) {
        return { error: await failure(caught, words("moderation.announcements.readFailed")) };
    }
}

const choiceSchema = z.object({
    installedAppId: serverId,
    id: z.string().trim().min(1).max(64),
    allow: z.boolean()
});

export async function setAnnouncementAction(input: {
    installedAppId: string;
    id: string;
    allow: boolean;
}): Promise<{ state?: announcements.AnnouncementsState; error?: string }> {
    const words = await gameWords("minecraft");
    const parsed = choiceSchema.safeParse(input);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.serverNotFound") };
    try {
        const { user, access } = await requireGameServer("games.manage", parsed.data.installedAppId);
        const state = await announcements.setAnnouncementAllowed(
            access.ownerId,
            parsed.data.installedAppId,
            parsed.data.id,
            parsed.data.allow
        );
        await recordAudit({
            actorId: user.id,
            action: parsed.data.allow
                ? "minecraft.announcements.allow"
                : "minecraft.announcements.block",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { mod: parsed.data.id }
        });
        return { state };
    } catch (caught) {
        return { error: await failure(caught, words("moderation.announcements.saveFailed")) };
    }
}
