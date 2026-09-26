/**
 * The values Polaris fills into announcements and the side panel: the server's
 * own, the call of the chat group chosen for it, and the Polaris account each
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
import { usesAccount, variablesIn, type VariableValues } from "./text-vars";

const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;
const { voicePresence } = host.chatCalls;

/** Where the chat group whose call `{call.*}` reads is kept on the install. */
export const CALL_GROUP_KEY = "callGroupId";

/** The chat group chosen for this server, or null. */
export function readCallGroup(config: Record<string, unknown>): string | null {
    const value = config[CALL_GROUP_KEY];
    return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

/** The names in a call, joined the way a line on screen reads them. */
function joined(names: readonly string[]): string {
    return names.join(", ");
}

/** How many people the chat group has - everybody the call could hold. */
async function groupSize(groupId: string): Promise<number> {
    return prisma.chatChannelMember.count({ where: { channelId: groupId } });
}

/**
 * Who is in the chat group's call right now, by the name they show there.
 *
 * Asked of the chat rather than read off the seats, so the panel and the chat
 * agree on who is there. A seat stays open for a while after somebody closes the
 * tab or loses the connection - only their browser going quiet says they left -
 * and counting open seats kept them "in call" on every screen long after the
 * chat had stopped showing them.
 */
async function callMembers(groupId: string): Promise<string[]> {
    const byChannel = await voicePresence([groupId]);
    return [...new Set((byChannel.get(groupId) ?? []).map((one) => one.name))];
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
    server?: Pick<ServerContainer, "say" | "run"> | null
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
    const group = readCallGroup(config);
    if (used.has("call.count") || used.has("call.members")) {
        const inCall = group ? await callMembers(group).catch(() => null) : null;
        values["call.count"] = inCall ? String(inCall.length) : null;
        values["call.members"] = inCall && inCall.length > 0 ? joined(inCall) : null;
    }
    if (used.has("call.max")) {
        const size = group ? await groupSize(group).catch(() => null) : null;
        values["call.max"] = size === null ? null : String(size);
    }

    const lists: Record<string, readonly string[]> = {};
    if (used.has(events.LEVELS_VARIABLE) && server) {
        const levels = events.readLevels(await server.say([events.LEVELS_COMMAND]).catch(() => ""));
        const rows = levels.map(events.levelText);
        values[events.LEVELS_VARIABLE] = rows.length > 0 ? joined(rows) : null;
        lists[events.LEVELS_VARIABLE] = rows;
    }
    if (used.has("death.player") || used.has("death.message")) {
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
    const tail = await server
        .run(["tail", "-c", String(events.DEATH_LOG_BYTES), events.SERVER_LOG])
        .catch(() => null);
    const found = tail && tail.code === 0 ? events.lastDeathInLog(tail.output) : null;
    if (!found || (kept && kept.player === found.player && kept.message === found.message)) {
        return kept;
    }
    const next: events.LastDeath = { ...found, at: Date.now() };
    await patchInstallConfig(installedAppId, { [events.LAST_DEATH_KEY]: next }).catch(() => undefined);
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
