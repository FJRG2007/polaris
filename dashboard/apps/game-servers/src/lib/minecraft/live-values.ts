/**
 * The values Polaris fills into announcements and the side panel: the server's
 * own, the call of the chat it is linked to, and the Polaris account each
 * player online is tied to. The words themselves are in `text-vars`.
 *
 * Asked only for what a text actually uses: a line with no `{polaris.*}` never
 * reads the links, and one with no `{server.*}` never asks the server who is on.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import type { PlayerList } from "./parse";
import type { Recipient, SendContext } from "./announcement";
import type { ServerContainer } from "./service";
import * as events from "./player-events";
import * as replies from "./events/replies";
import { linkedChannels, readChatLink, type ChatLink } from "./chat-link";
import { searchContainerTail } from "../container-files";
import { eventWins, readEventState } from "./events/state";
import {
    EVENTS_RANKING,
    INLINE_TOP,
    LEVEL_RANKING,
    STATS_RANKINGS,
    rankLines,
    statsRanking,
    type PlayerFigures
} from "./rankings";
import {
    DEATH_VARIABLES,
    LEVELS_VARIABLE,
    usesAccount,
    variablesIn,
    type VariableValues
} from "./text-vars";

const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;
const { voicePresence } = host.chatCalls;

/** The names in a call, joined the way a line on screen reads them. */
function joined(names: readonly string[]): string {
    return names.join(", ");
}

/**
 * Everybody the linked call could hold: the group's members, or for a voice
 * channel of a space its limit when it has one, and otherwise whoever may walk
 * in - the members of the room when it is private, of the space when it is not.
 */
async function callSize(link: ChatLink): Promise<number | null> {
    if (link.kind === "group") {
        return prisma.chatChannelMember.count({ where: { channelId: link.groupId } });
    }
    if (!link.callChannelId) return null;
    const room = await prisma.chatChannel.findUnique({
        where: { id: link.callChannelId },
        select: { userLimit: true, private: true }
    });
    if (!room) return null;
    if (room.userLimit > 0) return room.userLimit;
    return room.private
        ? prisma.chatChannelMember.count({ where: { channelId: link.callChannelId } })
        : prisma.chatSpaceMember.count({ where: { spaceId: link.spaceId } });
}

/**
 * Who is in the linked call right now, by the name they show there.
 *
 * Asked of the chat rather than read off the seats, so the panel and the chat
 * agree on who is there. A seat stays open for a while after somebody closes the
 * tab or loses the connection - only their browser going quiet says they left -
 * and counting open seats kept them "in call" on every screen long after the
 * chat had stopped showing them.
 */
async function callMembers(channelId: string): Promise<string[]> {
    const byChannel = await voicePresence([channelId]);
    return [...new Set((byChannel.get(channelId) ?? []).map((one) => one.name))];
}

/**
 * Everything the texts need to be written, read once.
 *
 * `players` is who is online as the caller already asked the server, or null
 * when it could not say: `{server.online}` and friends then read as their
 * fallbacks rather than as a count that is wrong. `server` is how everybody's
 * level and the log are read, for the texts that need them (`readsServer`);
 * without it those read as their fallbacks, or as the last death kept.
 */
export async function liveContext(
    installedAppId: string,
    texts: readonly string[],
    players: PlayerList | null,
    server?: Pick<ServerContainer, "say" | "run"> | null,
    /** Every player's figures, for the rankings that read them. */
    readFigures?: () => Promise<readonly PlayerFigures[]>
): Promise<SendContext> {
    const used = new Set(texts.flatMap((text) => variablesIn(text)).map((use) => use.spec?.name));
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { name: true, config: true }
    });
    const config = readInstallConfig(row?.config);

    const values: Record<string, string | null> = {
        "server.name": row?.name ?? null,
        "server.online": players ? String(players.online) : null,
        "server.max": players ? String(players.max) : null,
        "server.players": players && players.players.length > 0 ? joined(players.players) : null
    };
    // The call of whatever the server is linked to in Chat (`chat-link`).
    const link = readChatLink(config);
    const call = linkedChannels(link).call;
    if (used.has("call.count") || used.has("call.members")) {
        const inCall = call ? await callMembers(call).catch(() => null) : null;
        values["call.count"] = inCall ? String(inCall.length) : null;
        values["call.members"] = inCall && inCall.length > 0 ? joined(inCall) : null;
    }
    if (used.has("call.max")) {
        const size = link && call ? await callSize(link).catch(() => null) : null;
        values["call.max"] = size === null ? null : String(size);
    }

    const lists: Record<string, readonly string[]> = {};
    const list = (name: string, rows: readonly string[], inline: readonly string[] = rows) => {
        values[name] = inline.length > 0 ? joined(inline) : null;
        lists[name] = rows;
    };
    if ((used.has(LEVELS_VARIABLE) || used.has(LEVEL_RANKING)) && server) {
        // One answer per player, run together on most servers: split by the
        // names online where a level meets the next name.
        const said = await server.say([events.LEVELS_COMMAND]).catch(() => "");
        let read = replies.canonicalReplies(said, null);
        if (read.needsRoster) {
            const roster = replies.rosterNames(await server.say([replies.ROSTER]).catch(() => ""));
            read = replies.canonicalReplies(said, roster);
        }
        const levels = events.readLevels(read.text);
        const rows = levels.map(events.levelText);
        list(LEVELS_VARIABLE, rows);
        const ranked = rankLines(levels.map((one) => ({ name: one.name, value: one.level })));
        list(LEVEL_RANKING, ranked, ranked.slice(0, INLINE_TOP));
    }
    const wanted = STATS_RANKINGS.filter((name) => used.has(name));
    if (wanted.length > 0 && readFigures) {
        const figures = await readFigures().catch(() => []);
        for (const name of wanted) {
            const ranked = statsRanking(name, figures);
            list(name, ranked, ranked.slice(0, INLINE_TOP));
        }
    }
    if (used.has(EVENTS_RANKING)) {
        const ranked = rankLines(eventWins(readEventState(config)));
        list(EVENTS_RANKING, ranked, ranked.slice(0, INLINE_TOP));
    }
    if (DEATH_VARIABLES.some((name) => used.has(name))) {
        const death = await lastDeath(installedAppId, config, server ?? null);
        values["death.player"] = death?.player ?? null;
        values["death.message"] = death?.message ?? null;
    }

    const recipients =
        texts.some((text) => usesAccount(text)) && players
            ? await accountsOf(installedAppId, players.players)
            : null;
    return { values, recipients, lists };
}

/**
 * The last death: the newest one in the end of the log, kept on the install as
 * soon as it is seen so a restart - which starts the log again - does not lose
 * it. Without a server to ask, or with nothing in the log, the one kept.
 */
async function lastDeath(
    installedAppId: string,
    config: Record<string, unknown>,
    server: Pick<ServerContainer, "run"> | null
): Promise<events.LastDeath | null> {
    const kept = events.readLastDeath(config);
    if (!server) return kept;
    // In pieces from the end: one command carries 16 KiB, and the newest deaths
    // are at the end of what would have been cut.
    const found = await searchContainerTail(
        server,
        events.SERVER_LOG,
        events.DEATH_LOG_BYTES,
        events.lastDeathInLog
    ).catch(() => null);
    if (!found || (kept && kept.player === found.player && kept.message === found.message)) {
        return kept;
    }
    const next: events.LastDeath = { ...found, at: Date.now() };
    await patchInstallConfig(installedAppId, { [events.LAST_DEATH_KEY]: next }).catch(
        () => undefined
    );
    return next;
}

/** Each player online, with the Polaris account they are tied to, if any. */
async function accountsOf(installedAppId: string, names: readonly string[]): Promise<Recipient[]> {
    const links = await prisma.gamePlayerLink.findMany({
        where: { installedAppId },
        select: { player: true, userId: true }
    });
    const users = await prisma.user.findMany({
        where: { id: { in: [...new Set(links.map((link) => link.userId))] } },
        select: { id: true, name: true, username: true }
    });
    const byId = new Map(users.map((user) => [user.id, user]));
    const byPlayer = new Map(
        links.map((link) => [link.player.toLowerCase(), byId.get(link.userId) ?? null])
    );
    return names.map((name) => {
        const account = byPlayer.get(name.toLowerCase()) ?? null;
        const values: VariableValues = {
            "polaris.name": account?.name?.trim() || null,
            "polaris.username": account?.username?.trim() || null
        };
        return { name, values };
    });
}
