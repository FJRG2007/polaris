"use server";

/**
 * The chat a Minecraft server is linked to (`chat-link.ts`): reading it, with
 * what the viewer could link it to instead, and saving it.
 *
 * A setting of the server, so the manager's. And only to a conversation the
 * person choosing it may link: a group they are in, or the rooms of a space they
 * run - otherwise this would be a way to read who is in a call nobody let them
 * see, and to write into a channel nobody let them write in. The link already
 * saved is left as it is, so another manager can still turn its commands on or
 * off, or turn a use off, without being in it - but showing its messages in the
 * game, or writing announcements into it, is asked of whoever turns that on.
 */

import { z } from "zod";
import { gameWords, issueText } from "../game-words";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import type { AppHostTypes } from "@polaris/app-host";
import { editionOf } from "../../lib/minecraft/service";
import { applySidebar } from "../../lib/minecraft/live-display-service";
import { forgetLinkedServers } from "../../lib/minecraft/chat-link-service";
import {
    chatLinkPatch,
    chatLinkSchema,
    linkRefusal,
    readChatLink,
    widensLink,
    type ChatLink
} from "../../lib/minecraft/chat-link";

const { recordAudit } = host.auditService;
const { requireGameServer } = host.appsInstallAccess;
const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;
const { linkableConversations } = host.chatLinks;

type LinkableConversations = AppHostTypes["LinkableConversations"];

const idSchema = z.string().uuid();

/** What the Linked chat screen draws from. */
export interface ChatLinkState {
    readonly link: ChatLink | null;
    /** What the viewer may link the server to. */
    readonly linkable: LinkableConversations;
    /** Whether the server is Java, the one edition a channel can be shown in. */
    readonly java: boolean;
}

async function stateOf(installedAppId: string, viewerId: string): Promise<ChatLinkState> {
    const [row, linkable] = await Promise.all([
        prisma.installedApp.findUnique({
            where: { id: installedAppId },
            select: { config: true, catalogId: true }
        }),
        linkableConversations(viewerId)
    ]);
    return {
        link: readChatLink(readInstallConfig(row?.config)),
        linkable,
        java: editionOf(row?.catalogId ?? "minecraft") === "java"
    };
}

export async function readChatLinkAction(
    installedAppId: string
): Promise<{ state?: ChatLinkState; error?: string }> {
    const parsed = idSchema.safeParse(installedAppId);
    if (!parsed.success) return { error: (await gameWords("games"))("errors.thatServerIsNotHere") };
    try {
        const { user } = await requireGameServer("games.manage", parsed.data);
        return { state: await stateOf(parsed.data, user.id) };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : (await gameWords("games"))("errors.thatCouldNotBeRead")
        };
    }
}

const saveInput = z.object({
    installedAppId: z.string().uuid(),
    link: chatLinkSchema.nullable()
});

/** Link the server to a chat, change what the link is used for, or unlink it. */
export async function saveChatLinkAction(
    input: z.input<typeof saveInput>
): Promise<{ state?: ChatLinkState; error?: string }> {
    const parsed = saveInput.safeParse(input);
    if (!parsed.success)
        return {
            error:
                (await issueText(parsed.error.issues[0]?.message)) ??
                (await gameWords("games"))("errors.checkTheLink")
        };
    const { installedAppId, link } = parsed.data;
    try {
        const { user, access } = await requireGameServer("games.manage", installedAppId);
        const current = await stateOf(installedAppId, user.id);
        if (link && widensLink(link, current.link)) {
            const refused = linkRefusal(link, current.linkable);
            if (refused) return { error: refused };
        }
        if (link?.relay && !current.java) {
            return { error: (await gameWords("games"))("errors.onlyAJavaServerCan") };
        }
        await patchInstallConfig(installedAppId, chatLinkPatch(link));
        forgetLinkedServers();
        // `{call.*}` on the side panel reads the call this names: redrawn now
        // rather than on the panel's next turn.
        await applySidebar(access.ownerId, installedAppId).catch(() => undefined);
        await recordAudit({
            actorId: user.id,
            action: link ? "games.chat.link" : "games.chat.unlink",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: link
                ? {
                      kind: link.kind,
                      target: link.kind === "group" ? link.groupId : link.spaceId,
                      commands: link.commands,
                      announcements: link.announcements,
                      relay: link.relay
                  }
                : {}
        });
        return { state: await stateOf(installedAppId, user.id) };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : (await gameWords("games"))("errors.thatCouldNotBeSaved")
        };
    }
}
