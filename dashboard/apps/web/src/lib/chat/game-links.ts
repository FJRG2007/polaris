/**
 * Conversations an app has linked one of its things to - a game server whose
 * operator chose the chat group, or the space's channels, it talks through.
 *
 * Chat knows nothing of any game. What it does with a link is the same whatever
 * is on the other end:
 *
 * - **a badge** on the conversation, in the rail and the header, naming what it
 *   is linked to - with a way to its page only for somebody who could open that
 *   page anyway;
 * - **commands**: a message that is nothing but `/online` in a conversation the
 *   app answers commands in is answered, as a line Polaris writes into it that
 *   everybody there reads. The writer is a member - Chat let them write - and
 *   the app answers only with what it shows about itself in public;
 * - and for the app's own screen, **what may be linked**: the groups somebody is
 *   in, and the channels of the spaces they run.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { commandIn } from "./chat-command";
import { postNoticeBody } from "./notices";
import { rateLimit } from "@/lib/rate-limit-service";
import { effectiveCanOn } from "@/lib/effective-access";
import { reachableSpaceIds, spaceAccess, type ChatActor } from "./access";
import {
    answerChatCommand,
    chatGameLinks,
    type ChatCommandSpec
} from "@/lib/app-extensions/registry";

/** A link as the rail and the header draw it. */
export interface ChatGameLinkView {
    readonly installedAppId: string;
    readonly name: string;
    /** The game it runs, by name. */
    readonly game: string;
    /** The game's mark, or null for one that is not served from `/logos`. */
    readonly logo: string | null;
    /** Its page, for a reader who may open it. Null for everybody else: the
     *  badge still says what the conversation is linked to. */
    readonly href: string | null;
    /** The commands answered here, for the composer's list. */
    readonly commands: readonly ChatCommandSpec[];
}

/**
 * The links on each of these conversations, as this reader sees them. A
 * conversation with none is absent. Never throws: a badge is not worth a rail
 * that does not load.
 */
export async function gameLinksFor(
    actor: ChatActor,
    channelIds: readonly string[]
): Promise<Map<string, ChatGameLinkView[]>> {
    const links = await chatGameLinks(channelIds).catch(() => []);
    const byChannel = new Map<string, ChatGameLinkView[]>();
    if (links.length === 0) return byChannel;

    // Once per server however many conversations it is linked to.
    const opens = new Map<string, Promise<boolean>>();
    const mayOpen = (installedAppId: string, ownerId: string) => {
        let answer = opens.get(installedAppId);
        if (!answer) {
            answer = effectiveCanOn(
                actor.id,
                "games.read",
                core.resourceRef("install", installedAppId),
                { ownerId }
            ).catch(() => false);
            opens.set(installedAppId, answer);
        }
        return answer;
    };

    for (const link of links) {
        const view: ChatGameLinkView = {
            installedAppId: link.installedAppId,
            name: link.name,
            game: link.game,
            // Only a mark this dashboard serves itself: the badge draws it, and
            // an address somewhere else is a request to somewhere else.
            logo: /^\/logos\/[\w.-]+$/.test(link.logo) ? link.logo : null,
            href: (await mayOpen(link.installedAppId, link.ownerId))
                ? `/apps/installed/${link.installedAppId}`
                : null,
            commands: link.commands
        };
        byChannel.set(link.channelId, [...(byChannel.get(link.channelId) ?? []), view]);
    }
    return byChannel;
}

/** How often one conversation's commands are answered. Each answer asks a
 *  server, and a room that types `/online` twenty times is asking twenty. */
const COMMANDS_PER_MINUTE = 6;

/**
 * Answer a message that has just been sent, when it is a command a linked app
 * answers in that conversation. Never throws and never fails the send: the
 * message is in the conversation either way.
 *
 * Only a message in the conversation itself - an answer lands in the
 * conversation, and one asked inside a thread would answer somewhere else.
 */
export async function answerCommand(messageId: string, actorId: string): Promise<void> {
    try {
        const message = await prisma.chatMessage.findUnique({
            where: { id: messageId },
            select: { body: true, channelId: true, parentId: true, kind: true, deletedAt: true }
        });
        if (!message || message.deletedAt || message.parentId || message.kind !== "text") return;
        const command = commandIn(message.body);
        if (!command) return;
        const offered = (await chatGameLinks([message.channelId])).some((link) =>
            link.commands.some((one) => one.name === command)
        );
        if (!offered) return;
        const allowed = await rateLimit(
            `chat-command:${message.channelId}`,
            COMMANDS_PER_MINUTE,
            60_000
        );
        if (!allowed.ok) return;
        const answers = await answerChatCommand({ channelId: message.channelId, command });
        for (const answer of answers) await postNoticeBody(message.channelId, answer, actorId);
    } catch (error) {
        console.error("polaris: a chat command could not be answered:", error);
    }
}

/** What somebody may link a thing of theirs to. */
export interface LinkableConversations {
    /** The groups they are in. */
    readonly groups: readonly { readonly id: string; readonly name: string }[];
    /** The spaces they run, each with the rooms they can see in it. */
    readonly spaces: readonly {
        readonly id: string;
        readonly name: string;
        readonly channels: readonly {
            readonly id: string;
            readonly name: string;
            readonly kind: "text" | "voice";
        }[];
    }[];
}

/** The most groups offered. */
const MOST_GROUPS = 200;

/**
 * The conversations this person may link something to.
 *
 * A group they are in: linking it shows its call and answers in it, and
 * somebody outside it would be reading a call nobody let them see. A space only
 * where they are its owner or an administrator: a link writes answers and
 * announcements into its channels, and that is a decision about the space
 * rather than about one room. Inside it, every open room and the private ones
 * they are in.
 */
export async function linkableConversations(userId: string): Promise<LinkableConversations> {
    const actor = { id: userId };
    const [memberships, reachable] = await Promise.all([
        prisma.chatChannelMember.findMany({
            where: { userId, channel: { kind: "group", archived: false } },
            select: { channel: { select: { id: true, name: true } } },
            take: MOST_GROUPS
        }),
        reachableSpaceIds(actor)
    ]);
    const levels = await Promise.all(
        [...reachable].map(async (spaceId) => ({
            spaceId,
            level: await spaceAccess(actor, spaceId)
        }))
    );
    const run = levels
        .filter((one) => one.level === "owner" || one.level === "admin")
        .map((one) => one.spaceId);
    const spaces = run.length
        ? await prisma.chatSpace.findMany({
              where: { id: { in: run }, archived: false },
              orderBy: [{ order: "asc" }, { createdAt: "asc" }],
              select: {
                  id: true,
                  name: true,
                  channels: {
                      where: { archived: false, kind: { in: ["text", "voice"] } },
                      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
                      select: {
                          id: true,
                          name: true,
                          kind: true,
                          private: true,
                          members: { where: { userId }, select: { id: true } }
                      }
                  }
              }
          })
        : [];
    return {
        groups: memberships
            .map((one) => ({ id: one.channel.id, name: one.channel.name || "Unnamed group" }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        spaces: spaces.map((space) => ({
            id: space.id,
            name: space.name,
            channels: space.channels
                .filter((channel) => !channel.private || channel.members.length > 0)
                .map((channel) => ({
                    id: channel.id,
                    name: channel.name,
                    kind: channel.kind === "voice" ? ("voice" as const) : ("text" as const)
                }))
        }))
    };
}

/**
 * A line an app writes into a conversation - an announcement repeated there -
 * as Polaris, the way a join is written. Never throws.
 */
export async function postAppNotice(
    channelId: string,
    body: string,
    actorId: string
): Promise<void> {
    await postNoticeBody(channelId, body, actorId);
}
