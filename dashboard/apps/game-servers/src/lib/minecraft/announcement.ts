/**
 * An announcement: a title across the middle of every screen, a line under it,
 * one above the hotbar, and a message in the chat - written with the same colour
 * and style codes as the server's description, and sent as the commands the game
 * draws them with.
 *
 * The text is kept in the description's notation (`&c`, `&l`, `&x&f&f...`), so
 * the editor, the preview and the commands are all read by `motd.ts`, and what is
 * previewed is what is sent. Turning it into commands happens here, once, for the
 * screen that previews them and for the action that sends them.
 *
 * Java draws a text component: a list of runs, each with its colour and styles,
 * any of the sixteen colours by name or any other by hex. Bedrock takes the same
 * verbs with a `rawtext` body, understands the section-sign codes inside it, and
 * has neither hex colours nor underline or strikethrough - so those are brought
 * down to what it can draw rather than sent to be ignored.
 *
 * Pure, so every command can be asserted without a server.
 */

import { BROADCAST_TAG } from "./broadcast";
import type { MinecraftEdition } from "./service";
import { COMMAND_BYTES_MAX, commandBytes } from "./command-size";
import { MOTD_COLORS, SECTION, motdSpans, stripMotd, type MotdSpan } from "./motd";
import {
    fillValues,
    gamePieces,
    objectivesIn,
    usesAccount,
    usesPerPlayer,
    variableProblem,
    visibleLength,
    type VariableValues
} from "./text-vars";

/** What one announcement says and how long it stays. */
export interface Announcement {
    /** Who it is for: everybody, or one player by name. */
    readonly target: string;
    readonly title: string;
    readonly subtitle: string;
    /** The line just above the hotbar. */
    readonly actionbar: string;
    /** The chat message. Up to `CHAT_MAX_LINES` lines. */
    readonly chat: string;
    /** Whether the chat message starts with `[Polaris]`, like every other line
     *  Polaris writes into the game. */
    readonly tagged: boolean;
    /** Seconds, as the dialog asks for them. */
    readonly fadeIn: number;
    readonly stay: number;
    readonly fadeOut: number;
    /** A sound every recipient hears, or empty for none. Java only. */
    readonly sound: string;
    /**
     * How long it stays: for the timings above (`timed`), until a moment
     * (`until`), or until somebody takes it down (`manual`). The last two keep
     * the title and the action bar up by sending them again.
     */
    readonly hold: Hold;
    /** When an `until` comes down, as an ISO moment; empty otherwise. */
    readonly until: string;
}

export type Hold = "timed" | "until" | "manual";

export const EVERYBODY = "@a";

/** How long one line may be before it stops fitting on a screen. */
export const LINE_MAX = 120;
export const CHAT_MAX_LINES = 4;
export const CHAT_MAX = 400;
/** The longest a title may stay, fading included. A title somebody wants on
 *  screen for longer than this is a sign, not an announcement. */
export const SECONDS_MAX = 60;

/** What the game does when nobody says otherwise: half a second in, three and a
 *  half on screen, one second out. */
export const DEFAULT_TIMING = { fadeIn: 0.5, stay: 3.5, fadeOut: 1 } as const;

export const BLANK_ANNOUNCEMENT: Announcement = {
    target: EVERYBODY,
    title: "",
    subtitle: "",
    actionbar: "",
    chat: "",
    tagged: true,
    ...DEFAULT_TIMING,
    sound: "",
    hold: "timed",
    until: ""
};

/** The sounds on offer, by what they are for rather than by resource name. */
export const ANNOUNCE_SOUNDS: readonly { readonly id: string; readonly label: string }[] = [
    { id: "", label: "No sound" },
    { id: "minecraft:block.note_block.pling", label: "Pling" },
    { id: "minecraft:entity.experience_orb.pickup", label: "Experience orb" },
    { id: "minecraft:entity.player.levelup", label: "Level up" },
    { id: "minecraft:ui.toast.challenge_complete", label: "Challenge complete" },
    { id: "minecraft:block.bell.use", label: "Bell" },
    { id: "minecraft:block.beacon.activate", label: "Beacon" },
    { id: "minecraft:block.note_block.bass", label: "Warning (bass)" },
    { id: "minecraft:event.raid.horn", label: "Raid horn" },
    { id: "minecraft:entity.ender_dragon.growl", label: "Dragon growl" }
];

/** Java's names for the sixteen colours, by hex, so a named colour is sent by
 *  name - every version reads a name, and only 1.16 and later read hex. */
const JAVA_COLOR_NAMES: Readonly<Record<string, string>> = {
    "#000000": "black",
    "#0000aa": "dark_blue",
    "#00aa00": "dark_green",
    "#00aaaa": "dark_aqua",
    "#aa0000": "dark_red",
    "#aa00aa": "dark_purple",
    "#ffaa00": "gold",
    "#aaaaaa": "gray",
    "#555555": "dark_gray",
    "#5555ff": "blue",
    "#55ff55": "green",
    "#55ffff": "aqua",
    "#ff5555": "red",
    "#ff55ff": "light_purple",
    "#ffff55": "yellow",
    "#ffffff": "white"
};

/** A player name, or the one selector this offers. Checked before anything is
 *  put into a command: a target is the one part of it that is not JSON. */
export function isAnnouncementTarget(target: string): boolean {
    return target === EVERYBODY || /^[A-Za-z0-9_]{1,16}$/.test(target);
}

/**
 * A name as a command can aim at it, or null for one it cannot.
 *
 * Java names are letters, digits and underscores. A Bedrock gamertag may also
 * hold spaces, which a command takes in quotes; anything else is not a name any
 * command here is going to be written around.
 */
export function playerSelector(name: string): string | null {
    if (/^[A-Za-z0-9_]{1,16}$/.test(name)) return name;
    if (/^[A-Za-z0-9_ ]{1,16}$/.test(name) && name.trim() === name) return `"${name}"`;
    return null;
}

/** One run as Java draws it. White is left out: it is what the game draws
 *  anyway, and a shorter command leaves more room under the length cap. */
function javaStyle(span: MotdSpan): Record<string, unknown> {
    const hex = span.color.toLowerCase();
    const color = JAVA_COLOR_NAMES[hex] ?? hex;
    return {
        ...(color !== "white" ? { color } : {}),
        ...(span.bold ? { bold: true } : {}),
        ...(span.italic ? { italic: true } : {}),
        ...(span.underline ? { underlined: true } : {}),
        ...(span.strikethrough ? { strikethrough: true } : {}),
        ...(span.obfuscated ? { obfuscated: true } : {})
    };
}

/**
 * A line of formatted text as a Java text component.
 *
 * Always a list starting with an empty run: in a component list the first entry
 * is the parent of the rest, and anything set on it - a colour, bold - would be
 * inherited by every run after it that did not say otherwise.
 *
 * A game variable left in the text (`{player}`, `{player.level}`) becomes the
 * component the game draws it with, styled as the words around it.
 */
export function javaComponent(text: string, prefix: boolean): string {
    const lines = motdSpans(text);
    const runs: Record<string, unknown>[] = [{ text: "" }];
    if (prefix) runs.push({ text: `[${BROADCAST_TAG}] `, color: "gray" });
    lines.forEach((spans, index) => {
        if (index > 0) runs.push({ text: "\n" });
        for (const span of spans) {
            for (const piece of gamePieces(span.text)) {
                runs.push(
                    "text" in piece
                        ? { text: piece.text, ...javaStyle(span) }
                        : { ...piece.component, ...javaStyle(span) }
                );
            }
        }
    });
    return JSON.stringify(runs);
}

/** The nearest of the sixteen, for Bedrock, which draws no other colour. */
function nearestCode(hex: string): string {
    const rgb = (value: string): [number, number, number] => [
        Number.parseInt(value.slice(1, 3), 16),
        Number.parseInt(value.slice(3, 5), 16),
        Number.parseInt(value.slice(5, 7), 16)
    ];
    const [r, g, b] = rgb(hex.toLowerCase());
    let best = "f";
    let distance = Number.POSITIVE_INFINITY;
    for (const [code, color] of Object.entries(MOTD_COLORS)) {
        const [cr, cg, cb] = rgb(color.hex.toLowerCase());
        const far = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
        if (far < distance) {
            distance = far;
            best = code;
        }
    }
    return best;
}

/**
 * A line of formatted text as Bedrock draws it: section-sign codes inside
 * `rawtext` entries, reset between runs so nothing leaks from one to the next.
 * A game variable is an entry of its own, drawn in whatever formatting the text
 * before it left on.
 */
export function bedrockComponent(text: string, prefix: boolean): string {
    const lines = motdSpans(text);
    const rawtext: Record<string, unknown>[] = [];
    let written = prefix ? `${SECTION}7[${BROADCAST_TAG}] ${SECTION}r` : "";
    lines.forEach((spans, index) => {
        if (index > 0) written += "\n";
        for (const span of spans) {
            if (!span.text) continue;
            const styles = [
                span.bold ? `${SECTION}l` : "",
                span.italic ? `${SECTION}o` : "",
                span.obfuscated ? `${SECTION}k` : ""
            ].join("");
            const codes = `${SECTION}r${SECTION}${nearestCode(span.color)}${styles}`;
            for (const piece of gamePieces(span.text)) {
                if ("text" in piece) {
                    written += `${codes}${piece.text}`;
                } else {
                    rawtext.push({ text: `${written}${codes}` }, piece.component);
                    written = "";
                }
            }
        }
    });
    if (written || rawtext.length === 0) rawtext.push({ text: written });
    return JSON.stringify({ rawtext });
}

/** Whether a field has anything to show once its codes are taken away. */
export function hasText(text: string): boolean {
    return motdSpans(text).some((spans) => spans.some((span) => span.text.trim().length > 0));
}

/** Seconds as the game counts time on a title: twentieths of a second. */
function ticks(seconds: number): number {
    return Math.max(0, Math.round(Math.min(seconds, SECONDS_MAX) * 20));
}

/**
 * How long the game keeps each thing up on its own, and so how often Polaris
 * sends it again while it is meant to stay.
 *
 * The action bar's time is the game's, not ours: it shows for about three
 * seconds whatever the title timings say, so "on screen for a minute" is the
 * line sent again every two. A title that stays takes the timings it is sent
 * with, so one held open is sent to stay a little longer than the gap before it
 * is sent again, with no fade in on the repeats.
 */
export const ACTIONBAR_EVERY_MS = 2_000;
export const HELD_TITLE_SECONDS = 12;
export const HELD_TITLE_EVERY_MS = 10_000;

/** The longest "until" reaches: a week. Past that it is a sign on the wall. */
export const UNTIL_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether an announcement has anything Polaris has to keep sending: an action
 *  bar meant to outlast the game's three seconds, or anything held open. */
export function needsRepeating(announcement: Announcement): boolean {
    if (announcement.hold !== "timed") return true;
    return hasText(announcement.actionbar) && announcement.stay * 1000 > ACTIONBAR_EVERY_MS;
}

/** When it stops being sent, as a moment, or null for "until it is stopped". */
export function holdEndsAt(announcement: Announcement, sentAt: number): number | null {
    if (announcement.hold === "manual") return null;
    if (announcement.hold === "until") {
        const moment = Date.parse(announcement.until);
        return Number.isFinite(moment) ? moment : sentAt;
    }
    return sentAt + announcement.stay * 1000;
}

/** Somebody the announcement reaches, and what Polaris knows about them. */
export interface Recipient {
    readonly name: string;
    readonly values: VariableValues;
}

/**
 * What the commands are written with.
 *
 * `values` are the server's, the same for everybody. `recipients` are who is
 * online with their account's values, asked for only when a line uses one; null
 * when it is not known, and then every account value reads as its fallback.
 */
export interface SendContext {
    readonly values: VariableValues;
    readonly recipients: readonly Recipient[] | null;
}

export const NO_CONTEXT: SendContext = { values: {}, recipients: null };

/** Which part of an announcement to write: all of it once, or the part that is
 *  sent again to keep it up. */
export type AnnouncementPart = "all" | "title" | "actionbar";

/**
 * The console lines that make the announcement happen, in the order they have to
 * be sent.
 *
 * The timing goes first because it applies to the next title, and the subtitle
 * before the title because a subtitle is only drawn when a title arrives - so a
 * subtitle on its own is sent with an empty title to carry it.
 *
 * A line that reads a player's own values is run as each of them: the game's
 * (`{player}`, their level) through `execute as <target> run ... @s`, where the
 * game fills them in; the account's by one line per player online, with their
 * values written in. Scores are only kept for objectives that exist, so the ones
 * a line reads are created before the whole announcement goes; a repeat of one
 * part is sent after that and does not ask again.
 */
export function announcementCommands(
    edition: MinecraftEdition,
    announcement: Announcement,
    context: SendContext = NO_CONTEXT,
    part: AnnouncementPart = "all"
): string[] {
    const target = announcement.target;
    if (!isAnnouncementTarget(target)) throw new Error("Choose everybody or one player");
    const java = edition !== "bedrock";
    const verb = java ? "title" : "titleraw";
    const body = (text: string, prefix = false): string =>
        java ? javaComponent(text, prefix) : bedrockComponent(text, prefix);
    const empty = java ? '{"text":""}' : '{"rawtext":[{"text":""}]}';

    /** One command, or one per recipient when the text reads their account. */
    const send = (command: string, text: string, write: (filled: string) => string): string[] => {
        if (usesAccount(text) && context.recipients) {
            const wanted = target === EVERYBODY ? null : target.toLowerCase();
            return context.recipients.flatMap((recipient) => {
                if (wanted !== null && recipient.name.toLowerCase() !== wanted) return [];
                const who = playerSelector(recipient.name);
                if (!who) return [];
                const filled = fillValues(text, { ...context.values, ...recipient.values });
                return [`execute as ${who} run ${command} @s ${write(filled)}`];
            });
        }
        const filled = fillValues(text, context.values);
        // Decided on what is left once Polaris's values are in: an account value
        // with nobody to read it for is its fallback, and only the game's own
        // variables still need the line run as each player.
        return usesPerPlayer(filled)
            ? [`execute as ${target} run ${command} @s ${write(filled)}`]
            : [`${command} ${target} ${write(filled)}`];
    };

    const held = announcement.hold !== "timed";
    const fields = [announcement.title, announcement.subtitle, announcement.actionbar];
    if (part === "all") fields.push(announcement.chat);
    const lines: string[] =
        java && part === "all"
            ? fields
                  .flatMap((text) => objectivesIn(text))
                  .filter(
                      (one, index, all) =>
                          all.findIndex((other) => other.name === one.name) === index
                  )
                  .map((one) => `scoreboard objectives add ${one.name} ${one.criterion}`)
            : [];

    const title = hasText(announcement.title);
    const subtitle = hasText(announcement.subtitle);
    if ((title || subtitle) && part !== "actionbar") {
        const fadeIn = part === "title" ? 0 : announcement.fadeIn;
        const stay = held ? HELD_TITLE_SECONDS : announcement.stay;
        lines.push(
            `${verb} ${target} times ${ticks(fadeIn)} ${ticks(stay)} ${ticks(announcement.fadeOut)}`
        );
        if (subtitle) {
            lines.push(
                ...send(verb, announcement.subtitle, (filled) => `subtitle ${body(filled)}`)
            );
        }
        lines.push(
            ...(title
                ? send(verb, announcement.title, (filled) => `title ${body(filled)}`)
                : [`${verb} ${target} title ${empty}`])
        );
    }
    if (hasText(announcement.actionbar) && part !== "title") {
        lines.push(...send(verb, announcement.actionbar, (filled) => `actionbar ${body(filled)}`));
    }
    if (part !== "all") return lines;
    if (hasText(announcement.chat)) {
        lines.push(
            ...send("tellraw", announcement.chat, (filled) => body(filled, announcement.tagged))
        );
    }
    if (
        java &&
        announcement.sound &&
        ANNOUNCE_SOUNDS.some((one) => one.id === announcement.sound)
    ) {
        lines.push(
            `execute as ${target} at @s run playsound ${announcement.sound} master @s ~ ~ ~ 1 1`
        );
    }
    return lines;
}

/** What takes an announcement off the screen straight away, rather than
 *  leaving it to fade. */
export function clearAnnouncementCommands(
    edition: MinecraftEdition,
    announcement: Announcement
): string[] {
    const target = announcement.target;
    if (!isAnnouncementTarget(target)) throw new Error("Choose everybody or one player");
    const lines: string[] = [];
    if (hasText(announcement.title) || hasText(announcement.subtitle)) {
        lines.push(`title ${target} clear`);
    }
    if (hasText(announcement.actionbar)) {
        lines.push(
            edition === "bedrock"
                ? `titleraw ${target} actionbar {"rawtext":[{"text":""}]}`
                : `title ${target} actionbar {"text":""}`
        );
    }
    return lines;
}

/** The fields a problem can be under. */
export type AnnouncementField = "title" | "subtitle" | "actionbar" | "chat" | "until" | "hold";

/**
 * What is wrong with an announcement, field by field, in words for under each
 * field - or an empty object for one that can be sent.
 *
 * The same function the editor runs on every keystroke and the server runs
 * before anything leaves, so the button is never live for something the server
 * then refuses.
 */
export function announcementProblems(
    announcement: Announcement,
    edition: MinecraftEdition,
    now: number = Date.now()
): Partial<Record<AnnouncementField, string>> {
    const problems: Partial<Record<AnnouncementField, string>> = {};
    const lineFields = ["title", "subtitle", "actionbar"] as const;
    for (const field of lineFields) {
        const text = announcement[field];
        const wrong = variableProblem(text, edition);
        const shown = visibleLength(stripMotd(text));
        if (wrong) problems[field] = wrong;
        else if (shown > LINE_MAX) problems[field] = `At most ${LINE_MAX} characters on screen`;
    }
    const chat = announcement.chat;
    const chatWrong = variableProblem(chat, edition);
    if (chatWrong) problems.chat = chatWrong;
    else if (chat.split("\n").length > CHAT_MAX_LINES) {
        problems.chat = `At most ${CHAT_MAX_LINES} lines`;
    } else if (visibleLength(stripMotd(chat)) > CHAT_MAX) {
        problems.chat = `At most ${CHAT_MAX} characters`;
    }

    // Each part becomes one command, and one command has to fit in what the
    // game reads at once. Said under the part that is too long, like any other
    // problem with it, rather than once for the whole announcement.
    const target = isAnnouncementTarget(announcement.target) ? announcement.target : EVERYBODY;
    for (const field of [...lineFields, "chat"] as const) {
        if (problems[field] || !hasText(announcement[field])) continue;
        const alone: Announcement = {
            ...BLANK_ANNOUNCEMENT,
            target,
            tagged: announcement.tagged,
            [field]: announcement[field]
        };
        const longest = Math.max(
            ...announcementCommands(edition, alone).map((line) => commandBytes(line))
        );
        if (longest > COMMAND_BYTES_MAX) {
            problems[field] = "Too much formatting for one line. Use fewer colours or styles here.";
        }
    }

    if (announcement.hold !== "timed") {
        const shows = lineFields.some((field) => hasText(announcement[field]));
        if (!shows) problems.hold = "Only the title, subtitle or action bar can stay on screen";
    }
    if (announcement.hold === "until") {
        const moment = Date.parse(announcement.until);
        if (!Number.isFinite(moment)) problems.until = "Choose when it comes down";
        else if (moment <= now + 10_000) problems.until = "That moment has already passed";
        else if (moment > now + UNTIL_MAX_MS) problems.until = "At most a week from now";
    }
    return problems;
}
