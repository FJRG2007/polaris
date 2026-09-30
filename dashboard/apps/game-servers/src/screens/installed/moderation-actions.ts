"use server";

/**
 * The Moderation tab: the chat rules the server holds players to, what it
 * stopped, and what the server's mods announce to players.
 *
 * Reading, and setting the chat rules, is the moderators', like the tab: the
 * rules reach the server on their own, with no restart. Letting a mod's
 * announcement through edits a file on the server, so it is the managers'.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import { gameWords, issueText, messageText } from "../game-words";
import * as announcements from "../../lib/minecraft/mod-announcements-service";
import * as chat from "../../lib/minecraft/chat-moderation-service";
import { chatModerationSchema, type ChatModeration } from "../../lib/minecraft/chat-moderation";

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

export async function readChatModerationAction(
    installedAppId: string
): Promise<{ state?: chat.ChatModerationState; error?: string }> {
    const words = await gameWords("minecraft");
    const parsed = serverId.safeParse(installedAppId);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.serverNotFound") };
    try {
        const { access } = await requireGameServer("games.moderate", parsed.data);
        const applicationId = access.install.applicationId;
        if (!applicationId) return { error: (await gameWords("games"))("errors.thisServerHasNotBeen") };
        return {
            state: await chat.chatModerationState(parsed.data, applicationId, access.ownerId)
        };
    } catch (caught) {
        return { error: await failure(caught, words("moderation.chat.readFailed")) };
    }
}

const rulesInput = z.object({ installedAppId: serverId, rules: chatModerationSchema });

/** Save the rules. The server takes them within half a minute, with no restart. */
export async function saveChatModerationAction(input: {
    installedAppId: string;
    rules: unknown;
}): Promise<{ rules?: ChatModeration; error?: string }> {
    const words = await gameWords("minecraft");
    const parsed = rulesInput.safeParse(input);
    if (!parsed.success) {
        return {
            error: (await issueText(parsed.error.issues[0]?.message)) ?? words("moderation.chat.saveFailed")
        };
    }
    try {
        const { user } = await requireGameServer("games.moderate", parsed.data.installedAppId);
        const rules = await chat.saveChatModeration(parsed.data.installedAppId, parsed.data.rules);
        await recordAudit({
            actorId: user.id,
            action: "minecraft.chat-moderation.save",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { enabled: String(rules.enabled) }
        });
        return { rules };
    } catch (caught) {
        return { error: await failure(caught, words("moderation.chat.saveFailed")) };
    }
}
