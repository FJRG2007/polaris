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
import { usesAccount, variablesIn, type VariableValues } from "./text-vars";

const { readInstallConfig } = host.appsInstallConfig;

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

/** Who is in the chat group's call right now, by the name they show there. */
async function callMembers(groupId: string): Promise<string[]> {
    const participants = await prisma.meetingParticipant.findMany({
        where: {
            leftAt: null,
            admission: "admitted",
            meeting: { channelId: groupId, endedAt: null }
        },
        select: { name: true },
        orderBy: { joinedAt: "asc" }
    });
    return [...new Set(participants.map((one) => one.name))];
}

/**
 * Everything the texts need to be written, read once.
 *
 * `players` is who is online as the caller already asked the server, or null
 * when it could not say: `{server.online}` and friends then read as their
 * fallbacks rather than as a count that is wrong.
 */
export async function liveContext(
    installedAppId: string,
    texts: readonly string[],
    players: PlayerList | null
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
    if (used.has("call.count") || used.has("call.members")) {
        const group = readCallGroup(config);
        const inCall = group ? await callMembers(group).catch(() => null) : null;
        values["call.count"] = inCall ? String(inCall.length) : null;
        values["call.members"] = inCall && inCall.length > 0 ? joined(inCall) : null;
    }

    if (!texts.some((text) => usesAccount(text))) return { values, recipients: null };
    if (!players) return { values, recipients: null };
    return { values, recipients: await accountsOf(installedAppId, players.players) };
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
