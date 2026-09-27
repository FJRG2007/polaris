/**
 * A Polaris Chat message, shown to one player in a Minecraft server's chat.
 *
 * Core has already decided the account wants it (see the dashboard's
 * `chat/game-relay`). What is left is the game's half: which players are that
 * account, and whether they are on.
 *
 * - **Who they are** is the link an operator made between a player and an
 *   account on that server (`GamePlayerLink`), and nothing looser. A name typed
 *   into a profile is a claim, and the words of somebody's messages are not
 *   something to hand to whoever happens to be called that.
 * - **And the account agrees**: an operator can tie any name to any account, so
 *   the link alone is only the operator's word. It counts where the account
 *   says the same - the name is the Minecraft account it connected, proved or
 *   typed - or where the server is the account's own.
 * - **Whether they are on** is the open visits the activity sweep already keeps
 *   (`GamePlayerSession`), so a message costs no question to any server that
 *   nobody linked to this account is playing on. A visit can be up to a minute
 *   old; a message sent to somebody who has just left is answered by the game
 *   with "no player was found" and is simply gone, which is the right outcome.
 * - **Only they see it**: `tellraw` to that one player.
 *
 * The words are sent as they were written - never read for `&` codes, and with
 * the game's own section sign taken out - so a message cannot restyle itself or
 * put a click action into somebody's chat. Java only: Bedrock has no private
 * line Polaris writes to.
 */

import { prisma } from "@polaris/db";
import { BROADCAST_TAG } from "./broadcast";
import { gameOfServer } from "@polaris/core";
import { playerSelector } from "./announcement";
import { editionOf, withServerContainer } from "./service";
import { COMMAND_BYTES_MAX, commandBytes } from "./command-size";

/** What arrives, as core describes it. */
export interface ChatRelayInput {
    readonly userId: string;
    readonly author: string;
    readonly conversation: string;
    readonly inChannel: boolean;
    /** The words, plain - a poll's question - or empty when there are none. */
    readonly text: string;
    /** What files it carries ("Photo", "3 files", a file's name), or null. */
    readonly files?: string | null;
    /** A poll's answers, or null when it is not a poll. */
    readonly poll?: readonly string[] | null;
    readonly forwarded?: boolean;
}

/** What marks a line as a Chat message: an envelope (U+2709). */
export const MESSAGE_MARK = "\u2709";

/** The longest message line sent into a game. */
const MOST_TEXT = 200;

/** The longest a file's name or a poll's answer is shown. */
const MOST_LABEL = 48;

/** The shortest a poll's answer is cut to so the line fits in one command. */
const LEAST_LABEL = 16;

/** The shortest the words are cut to so the line fits in one command. */
const LEAST_TEXT = 24;

/** The game's formatting character and anything that is not a printable line. */
function literal(value: string, max: number): string {
    const clean = value
        .replace(/\u00a7/g, "")
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .trim();
    return clean.length > max ? `${clean.slice(0, max - 3).trimEnd()}...` : clean;
}

/**
 * The `tellraw` that shows one message to one player, or null when the player's
 * name cannot be written as a target. Everything but the tag is plain text.
 *
 * What is not words gets a label of its own beside them, so a photo with a
 * caption reads as both and a voice note is not an empty line: `[Photo]`,
 * `[3 files]`, a poll's question and answers, and whether it was forwarded.
 * Where it all would not fit in one command the words are cut first, then a
 * poll's answers, and the other labels are kept.
 */
export function relayCommand(
    player: string,
    message: Omit<ChatRelayInput, "userId">
): string | null {
    const target = playerSelector(player);
    if (!target) return null;
    const author = literal(message.author, 48) || "Somebody";
    const where = literal(message.conversation, 48);
    // An envelope ahead of the tag, so a message reads as one at a glance among
    // the server's own lines; the game's font draws it without a resource pack.
    const head: Record<string, unknown>[] = [
        { text: "" },
        { text: `${MESSAGE_MARK} `, color: "aqua" },
        { text: `[${BROADCAST_TAG}] `, color: "gray" },
        { text: author, color: "yellow" }
    ];
    // A direct message is named after its author; saying "Ana in Ana" is noise.
    if (where && where !== author) {
        head.push({ text: message.inChannel ? ` in #${where}` : ` in ${where}`, color: "gray" });
    }
    head.push({ text: ": ", color: "gray" });
    if (message.forwarded) head.push({ text: "[Forwarded] ", color: "gray", italic: true });

    const poll = (message.poll ?? []).map((one) => literal(one, MOST_LABEL)).filter(Boolean);
    const files = message.files ? literal(message.files, MOST_LABEL) : "";
    const body = (max: number, answers: readonly string[]): Record<string, unknown>[] => {
        const runs: Record<string, unknown>[] = [];
        const words = literal(message.text, max);
        if (message.poll) runs.push({ text: "[Poll] ", color: "aqua" });
        if (words) runs.push({ text: words });
        if (answers.length > 0) runs.push({ text: ` (${answers.join(" / ")})`, color: "gray" });
        if (files) runs.push({ text: `${runs.length > 0 ? " " : ""}[${files}]`, color: "aqua" });
        if (runs.length === 0) runs.push({ text: "Sent a message", color: "gray", italic: true });
        return runs;
    };
    const fitting = (max: number, answers: readonly string[]): string | null => {
        const line = `tellraw ${target} ${JSON.stringify([...head, ...body(max, answers)])}`;
        return commandBytes(line) <= COMMAND_BYTES_MAX ? line : null;
    };
    for (let max = MOST_TEXT; max >= LEAST_TEXT; max = Math.floor(max / 2)) {
        const line = fitting(max, poll);
        if (line) return line;
    }
    // Then a poll's answers: shorter, and at last only as many as fit.
    const short = poll.map((one) => literal(one, LEAST_LABEL));
    for (let kept = short.length; kept >= 0; kept -= 1) {
        const answers = kept < short.length ? [...short.slice(0, kept), "..."] : short;
        const line = fitting(LEAST_TEXT, answers);
        if (line) return line;
    }
    return null;
}

/** Where to show it: each Java server this account is linked on and playing on
 *  right now, with the player's name as that server spells it. */
export async function relayTargets(
    userId: string
): Promise<{ installedAppId: string; ownerId: string; player: string }[]> {
    const links = await prisma.gamePlayerLink.findMany({
        where: { userId },
        select: { installedAppId: true, player: true }
    });
    if (links.length === 0) return [];
    const connected = await prisma.userConnection.findMany({
        where: { userId, provider: "minecraft" },
        select: { label: true }
    });
    const ownNames = new Set(connected.map((connection) => connection.label.toLowerCase()));

    const installs = await prisma.installedApp.findMany({
        where: {
            id: { in: [...new Set(links.map((link) => link.installedAppId))] },
            status: { not: "removed" }
        },
        select: { id: true, ownerId: true, catalogId: true }
    });
    const java = installs.filter(
        (install) =>
            gameOfServer(install.catalogId)?.id === "minecraft" &&
            editionOf(install.catalogId) === "java"
    );
    if (java.length === 0) return [];

    const open = await prisma.gamePlayerSession.findMany({
        where: { installedAppId: { in: java.map((install) => install.id) }, leftAt: null },
        select: { installedAppId: true, name: true }
    });
    const owners = new Map(java.map((install) => [install.id, install.ownerId]));
    const targets: { installedAppId: string; ownerId: string; player: string }[] = [];
    for (const link of links) {
        const ownerId = owners.get(link.installedAppId);
        if (!ownerId) continue;
        if (ownerId !== userId && !ownNames.has(link.player.toLowerCase())) continue;
        const on = open.find(
            (visit) =>
                visit.installedAppId === link.installedAppId &&
                visit.name.toLowerCase() === link.player.toLowerCase()
        );
        if (on) targets.push({ installedAppId: link.installedAppId, ownerId, player: on.name });
    }
    return targets;
}

/** Show the message to each of this account's players who are on. One server
 *  that will not take it does not stop the next. */
export async function relayChatToMinecraft(message: ChatRelayInput): Promise<void> {
    for (const target of await relayTargets(message.userId)) {
        const line = relayCommand(target.player, message);
        if (!line) continue;
        await withServerContainer(target.ownerId, target.installedAppId, async (server) => {
            if (server.running) await server.say([line]);
        }).catch((error: unknown) => {
            console.error("polaris: a message could not be shown in Minecraft:", String(error));
        });
    }
}
