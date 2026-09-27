/**
 * What the chat a server is linked to does, on the server side: the badge Chat
 * draws on a linked conversation, the answers to `/online` and `/status`, an
 * announcement repeated in the channel, and the channel shown in the game.
 *
 * All of it reads the one record (`chat-link.ts`). Chat itself knows nothing of
 * any game; it asks through the app extension, and this is what answers.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { findGame } from "@polaris/core";
import type { VariableValues } from "./text-vars";
import type { Announcement } from "./announcement";
import type { ChatRelayInput } from "./chat-relay";
import type { AppHostTypes } from "@polaris/app-host";
import {
    CHAT_COMMANDS,
    announcementMirror,
    commandAnswer,
    isChatCommand,
    linkedChannelIds,
    linkedChannels,
    readChatLink,
    type ChatLink
} from "./chat-link";

const { readInstallConfig } = host.appsInstallConfig;

type ChatGameLink = AppHostTypes["ChatGameLink"];

const MINECRAFT = findGame("minecraft");

/** One Minecraft server with a chat linked to it. */
interface LinkedServer {
    readonly installedAppId: string;
    readonly ownerId: string;
    readonly catalogId: string;
    readonly name: string;
    readonly link: ChatLink;
    readonly config: Record<string, unknown>;
}

/**
 * Every Minecraft server that is linked to a chat.
 *
 * One query over the servers rather than a lookup by channel: the link lives in
 * each server's own config, an instance has a handful of servers, and keeping a
 * second copy of the link where a query could reach it by channel would be a
 * second record to keep in step with the first.
 */
async function linkedServers(): Promise<LinkedServer[]> {
    if (!MINECRAFT) return [];
    const rows = await prisma.installedApp.findMany({
        where: { catalogId: { in: [...MINECRAFT.serverCatalogIds] }, status: { not: "removed" } },
        select: { id: true, ownerId: true, catalogId: true, name: true, config: true }
    });
    return rows.flatMap((row) => {
        const config = readInstallConfig(row.config);
        const link = readChatLink(config);
        return link
            ? [
                  {
                      installedAppId: row.id,
                      ownerId: row.ownerId,
                      catalogId: row.catalogId,
                      name: row.name,
                      link,
                      config
                  }
              ]
            : [];
    });
}

/** The servers linked to each of these conversations, for Chat's badge. */
export async function chatGameLinks(channelIds: readonly string[]): Promise<ChatGameLink[]> {
    const wanted = new Set(channelIds);
    if (wanted.size === 0 || !MINECRAFT) return [];
    const found: ChatGameLink[] = [];
    for (const server of await linkedServers()) {
        const text = linkedChannels(server.link).text;
        for (const channelId of linkedChannelIds(server.link)) {
            if (!wanted.has(channelId)) continue;
            found.push({
                channelId,
                installedAppId: server.installedAppId,
                ownerId: server.ownerId,
                name: server.name,
                game: MINECRAFT.name,
                logo: MINECRAFT.logo,
                commands:
                    channelId === text && server.link.commands
                        ? CHAT_COMMANDS.map((command) => ({ ...command }))
                        : []
            });
        }
    }
    return found;
}

/**
 * The answers to a command somebody wrote in a conversation: one from each
 * server whose linked channel it is and which takes commands there. Empty when
 * it is not one of these commands, or not such a channel.
 *
 * The person asking is already a member of the conversation - Chat let them
 * write in it - and what comes back is what the server shows anybody who looks
 * it up in a game's server list: whether it is up, how full, and who is on.
 */
export async function answerChatCommand(input: {
    readonly channelId: string;
    readonly command: string;
}): Promise<string[]> {
    const command = input.command.toLowerCase();
    if (!isChatCommand(command)) return [];
    const servers = (await linkedServers()).filter(
        (server) => server.link.commands && linkedChannels(server.link).text === input.channelId
    );
    if (servers.length === 0) return [];
    const { serverReading } = await import("./service");
    const answers: string[] = [];
    for (const server of servers) {
        const reading = await serverReading(server.ownerId, server.installedAppId).catch(() => ({
            running: true,
            players: null
        }));
        const release = typeof server.config.mcRelease === "string" ? server.config.mcRelease : "";
        answers.push(
            commandAnswer(command, {
                name: server.name,
                running: reading.running,
                players: reading.players,
                release: release.trim() || null
            })
        );
    }
    return answers;
}

/** The Java servers that show this channel to everybody playing. */
async function serversRelaying(channelId: string): Promise<LinkedServer[]> {
    const { editionOf } = await import("./service");
    return (await linkedServers()).filter(
        (server) =>
            server.link.relay &&
            linkedChannels(server.link).text === channelId &&
            editionOf(server.catalogId) === "java"
    );
}

/** Which servers already show this channel's messages to everybody playing. */
export async function serversShowing(channelId: string): Promise<Set<string>> {
    return new Set((await serversRelaying(channelId)).map((server) => server.installedAppId));
}

/**
 * Show a message said in a linked channel to everybody playing on each server
 * that shows that channel. One server that will not take it does not stop the
 * next, and a stopped one is not asked.
 */
export async function relayChannelMessage(
    message: Omit<ChatRelayInput, "userId" | "inChannel"> & { readonly channelId: string }
): Promise<void> {
    const servers = await serversRelaying(message.channelId);
    if (servers.length === 0) return;
    const [{ relayLine }, { withServerContainer }] = await Promise.all([
        import("./chat-relay"),
        import("./service")
    ]);
    const line = relayLine("@a", { ...message, inChannel: true });
    if (!line) return;
    for (const server of servers) {
        await withServerContainer(server.ownerId, server.installedAppId, async (container) => {
            if (container.running) await container.say([line]);
        }).catch((error: unknown) => {
            console.error(
                "polaris: a channel message could not be shown in Minecraft:",
                String(error)
            );
        });
    }
}

/**
 * Repeat an announcement that was just sent in the server's linked channel,
 * where the link asks for it. Never throws: the announcement reached the
 * players, and a line in a chat is not worth reporting it as failed over.
 */
export async function mirrorAnnouncement(
    installedAppId: string,
    serverName: string,
    /** The install's config, as stored. */
    config: string | null,
    announcement: Announcement,
    values: VariableValues,
    actorId: string
): Promise<void> {
    const link = readChatLink(readInstallConfig(config));
    const text = linkedChannels(link).text;
    if (!link?.announcements || !text) return;
    const line = announcementMirror(serverName, announcement, values);
    if (!line) return;
    await host.chatLinks.postAppNotice(text, line, actorId).catch((error: unknown) => {
        console.error(`polaris: ${installedAppId}'s announcement was not repeated in chat:`, error);
    });
}
