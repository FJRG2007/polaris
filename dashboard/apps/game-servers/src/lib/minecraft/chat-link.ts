/**
 * The chat a Minecraft server is linked to, as it is recorded on the install.
 *
 * One record, and the only place anything asks "which conversation is this
 * server's": the call `{call.*}` reads, the channel its members ask the server
 * about with `/online`, where an announcement is repeated, and the channel whose
 * messages are shown in the game.
 *
 * A server is linked to one of two things Chat has:
 *
 * - **a group**, which is a single conversation with a call of its own - so the
 *   group is both the call and the channel, and there is nothing else to choose;
 * - **a space**, which holds rooms: a voice channel for the call and a text
 *   channel for the rest, each chosen, each optional.
 *
 * Before this existed a server only chose a group for `{call.*}`, kept under
 * `callGroupId`. That value is still read when nothing newer is recorded, as a
 * group link, so a server set up then keeps its call - and saving the link here
 * clears it, leaving one record.
 *
 * Pure, so the screen, the service and the tests read it the same way.
 */

import { z } from "zod";
import { stripMotd } from "./motd";
import type { PlayerList } from "./parse";
import { EVERYBODY } from "./announce-target";
import type { Announcement } from "./announcement";
import { fillValues, usesPerPlayer, type VariableValues } from "./text-vars";

/** Where the link is kept on the install. */
export const CHAT_LINK_KEY = "chatLink";

/** Where the chat group whose call `{call.*}` read was kept before the link. */
export const CALL_GROUP_KEY = "callGroupId";

const id = z.string().uuid();

/** What the linked channel is used for, beyond the call. */
const uses = {
    /** Members may ask the server about itself there (`/online`, `/status`). */
    commands: z.boolean(),
    /** An announcement sent to everybody is repeated there. */
    announcements: z.boolean(),
    /** Its messages are shown to everybody playing. Java only. */
    relay: z.boolean()
};

export const chatLinkSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("group"), groupId: id, ...uses }),
    z.object({
        kind: z.literal("space"),
        spaceId: id,
        /** The voice channel whose call `{call.*}` reads, or null. */
        callChannelId: id.nullable(),
        /** The text channel the rest happens in, or null. */
        textChannelId: id.nullable(),
        ...uses
    })
]);

export type ChatLink = z.infer<typeof chatLinkSchema>;

/** What a link to a group starts as: the commands on, the rest off. */
export function groupLink(groupId: string): ChatLink {
    return { kind: "group", groupId, commands: true, announcements: false, relay: false };
}

/**
 * The server's link, or null.
 *
 * A stored link wins. With none, the group chosen for `{call.*}` before the
 * link existed, read as a link to that group - the call it fed is kept, and the
 * group is what its members already knew the server by. Only the call: nobody
 * there asked for the server to start answering in it, so everything else stays
 * off until somebody turns it on.
 */
export function readChatLink(config: Record<string, unknown>): ChatLink | null {
    const stored = chatLinkSchema.safeParse(config[CHAT_LINK_KEY]);
    if (stored.success) return stored.data;
    const legacy = config[CALL_GROUP_KEY];
    return typeof legacy === "string" && id.safeParse(legacy).success
        ? { ...groupLink(legacy), commands: false }
        : null;
}

/** The two channels a link resolves to. A group is both. */
export function linkedChannels(link: ChatLink | null): {
    readonly call: string | null;
    readonly text: string | null;
} {
    if (!link) return { call: null, text: null };
    if (link.kind === "group") return { call: link.groupId, text: link.groupId };
    return { call: link.callChannelId, text: link.textChannelId };
}

/** Every channel a link names, for the badge Chat draws on each. */
export function linkedChannelIds(link: ChatLink | null): string[] {
    const { call, text } = linkedChannels(link);
    return [...new Set([call, text].filter((one): one is string => one !== null))];
}

/** The config patch that records a link, and clears the value it replaced. */
export function chatLinkPatch(link: ChatLink | null): Record<string, unknown> {
    return { [CHAT_LINK_KEY]: link, [CALL_GROUP_KEY]: null };
}

/** What somebody may link a server to, as Chat answers it. */
export interface Linkable {
    readonly groups: readonly { readonly id: string; readonly name: string }[];
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

/**
 * Whether saving `next` over `current` needs the person saving it to be allowed
 * to link that conversation: a different conversation, or one that now shows
 * its messages in the game or has announcements written into it. Answering
 * commands, or turning a use off, is any manager's to change.
 */
export function widensLink(next: ChatLink, current: ChatLink | null): boolean {
    if (!sameTarget(next, current)) return true;
    return (next.relay && !current?.relay) || (next.announcements && !current?.announcements);
}

/** Whether two links name the same conversation, whatever they are used for. */
export function sameTarget(left: ChatLink | null, right: ChatLink | null): boolean {
    if (!left || !right) return false;
    if (left.kind === "group") return right.kind === "group" && left.groupId === right.groupId;
    return (
        right.kind === "space" &&
        left.spaceId === right.spaceId &&
        left.callChannelId === right.callChannelId &&
        left.textChannelId === right.textChannelId
    );
}

/**
 * Why a link may not be made by somebody who may link to `linkable`, or null
 * when it may: a group they are in, or rooms of the right kind in a space they
 * run.
 */
export function linkRefusal(link: ChatLink, linkable: Linkable): string | null {
    if (link.kind === "group") {
        return linkable.groups.some((group) => group.id === link.groupId)
            ? null
            : "Choose a group you are in";
    }
    const space = linkable.spaces.find((one) => one.id === link.spaceId);
    if (!space) return "Choose a space you run";
    if (!link.callChannelId && !link.textChannelId) {
        return "Choose a voice channel, a text channel, or both";
    }
    const fits = (id: string | null, kind: "text" | "voice") =>
        id === null || space.channels.some((channel) => channel.id === id && channel.kind === kind);
    if (!fits(link.callChannelId, "voice")) return "Choose a voice channel of that space";
    if (!fits(link.textChannelId, "text")) return "Choose a text channel of that space";
    return null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** What members of the linked channel may ask the server. */
export const CHAT_COMMANDS = [
    { name: "online", description: "Who is playing right now" },
    { name: "status", description: "Whether the server is up, and how full it is" }
] as const;

export type ChatCommandName = (typeof CHAT_COMMANDS)[number]["name"];

export function isChatCommand(name: string): name is ChatCommandName {
    return CHAT_COMMANDS.some((command) => command.name === name);
}

/** The most names an answer lists before it says how many more there are. */
export const MOST_NAMES = 20;

/** What the server is doing, as a command's answer needs it. */
export interface ServerReading {
    /** The server's name, as its page calls it. */
    readonly name: string;
    /** Whether it is meant to be running. */
    readonly running: boolean;
    /** Who is on, or null when it did not answer. */
    readonly players: PlayerList | null;
    /** The Minecraft release it was built on, or null when that is not known. */
    readonly release: string | null;
}

/** A server's name as a line of chat writes it: nothing Chat reads as markup. */
function named(name: string): string {
    return name.replace(/[[\]()*_`~<>\\]/g, "").trim() || "The server";
}

/** A player's name as a line of chat writes it: nothing that could pass for a
 *  mention of somebody's account. */
function playerName(name: string): string {
    return name.replace(/[[\]()<>\\]/g, "").trim() || "?";
}

function names(players: readonly string[]): string {
    const shown = players.slice(0, MOST_NAMES).map(playerName).join(", ");
    const more = players.length - MOST_NAMES;
    return more > 0 ? `${shown} and ${more} more` : shown;
}

/** The answer to `/online`. */
export function onlineAnswer(reading: ServerReading): string {
    const name = named(reading.name);
    if (!reading.running) return `${name} is not running.`;
    const players = reading.players;
    if (!players) return `${name} is not answering right now.`;
    if (players.online === 0 || players.players.length === 0) {
        return `Nobody is playing on ${name} (0 of ${players.max}).`;
    }
    return `${players.online} of ${players.max} playing on ${name}: ${names(players.players)}`;
}

/** The answer to `/status`. */
export function statusAnswer(reading: ServerReading): string {
    const name = named(reading.name);
    if (!reading.running) return `${name} is stopped.`;
    const players = reading.players;
    if (!players) return `${name} is starting, or not answering right now.`;
    const release =
        reading.release && reading.release.toUpperCase() !== "LATEST"
            ? `, Minecraft ${reading.release}`
            : "";
    return `${name} is up - ${players.online} of ${players.max} playing${release}.`;
}

export function commandAnswer(command: ChatCommandName, reading: ServerReading): string {
    return command === "online" ? onlineAnswer(reading) : statusAnswer(reading);
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

/** The longest an announcement is repeated in the chat. */
const MIRROR_MAX = 600;

/**
 * An announcement as a line in the linked channel, or null when there is
 * nothing to repeat.
 *
 * Only one sent to everybody: one aimed at a player, or at the operators, is not
 * the channel's business. A text that is written differently for each player
 * (`{player}`, `{polaris.name}`) is left out, since there is no one version of
 * it to show; the rest are filled in the way the players saw them, without the
 * colours.
 */
export function announcementMirror(
    serverName: string,
    announcement: Pick<Announcement, "target" | "title" | "subtitle" | "actionbar" | "chat">,
    values: VariableValues
): string | null {
    if (announcement.target !== EVERYBODY) return null;
    const parts = [
        announcement.title,
        announcement.subtitle,
        announcement.actionbar,
        announcement.chat
    ]
        .filter((text) => text.trim() !== "" && !usesPerPlayer(text))
        .map((text) => stripMotd(fillValues(text, values)).replace(/\s+/g, " ").trim())
        .filter(Boolean);
    if (parts.length === 0) return null;
    const line = `Announced on ${named(serverName)}: ${parts.join(" - ")}`;
    return line.length > MIRROR_MAX ? `${line.slice(0, MIRROR_MAX - 3).trimEnd()}...` : line;
}
