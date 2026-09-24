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
import { MOTD_COLORS, SECTION, motdSpans, type MotdSpan } from "./motd";

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
}

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
    sound: ""
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

/** One run as Java draws it. White is left out: it is what the game draws
 *  anyway, and a shorter command leaves more room under the length cap. */
function javaRun(span: MotdSpan): Record<string, unknown> {
    const hex = span.color.toLowerCase();
    const color = JAVA_COLOR_NAMES[hex] ?? hex;
    return {
        text: span.text,
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
 */
export function javaComponent(text: string, prefix: boolean): string {
    const lines = motdSpans(text);
    const runs: Record<string, unknown>[] = [{ text: "" }];
    if (prefix) runs.push({ text: `[${BROADCAST_TAG}] `, color: "gray" });
    lines.forEach((spans, index) => {
        if (index > 0) runs.push({ text: "\n" });
        for (const span of spans) if (span.text) runs.push(javaRun(span));
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

/** A line of formatted text as Bedrock draws it: section-sign codes inside one
 *  `rawtext` entry, reset between runs so nothing leaks from one to the next. */
export function bedrockComponent(text: string, prefix: boolean): string {
    const lines = motdSpans(text);
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
            written += `${SECTION}r${SECTION}${nearestCode(span.color)}${styles}${span.text}`;
        }
    });
    return JSON.stringify({ rawtext: [{ text: written }] });
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
 * The console lines that make the announcement happen, in the order they have to
 * be sent.
 *
 * The timing goes first because it applies to the next title, and the subtitle
 * before the title because a subtitle is only drawn when a title arrives - so a
 * subtitle on its own is sent with an empty title to carry it.
 */
export function announcementCommands(
    edition: MinecraftEdition,
    announcement: Announcement
): string[] {
    const target = announcement.target;
    if (!isAnnouncementTarget(target)) throw new Error("Choose everybody or one player");
    const java = edition !== "bedrock";
    const verb = java ? "title" : "titleraw";
    const body = (text: string, prefix = false): string =>
        java ? javaComponent(text, prefix) : bedrockComponent(text, prefix);
    const empty = java ? '{"text":""}' : '{"rawtext":[{"text":""}]}';

    const lines: string[] = [];
    const title = hasText(announcement.title);
    const subtitle = hasText(announcement.subtitle);
    if (title || subtitle) {
        lines.push(
            `${verb} ${target} times ${ticks(announcement.fadeIn)} ${ticks(announcement.stay)} ${ticks(announcement.fadeOut)}`
        );
        if (subtitle) lines.push(`${verb} ${target} subtitle ${body(announcement.subtitle)}`);
        lines.push(`${verb} ${target} title ${title ? body(announcement.title) : empty}`);
    }
    if (hasText(announcement.actionbar)) {
        lines.push(`${verb} ${target} actionbar ${body(announcement.actionbar)}`);
    }
    if (hasText(announcement.chat)) {
        lines.push(`tellraw ${target} ${body(announcement.chat, announcement.tagged)}`);
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
