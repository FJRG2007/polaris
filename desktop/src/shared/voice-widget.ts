/**
 * The voice widget: the call's people, drawn in a small window that stays over
 * every other one - a game included, when it runs windowed or borderless - the
 * way a voice app's in-game overlay does.
 *
 * The dashboard page in the call says who is in it and who is speaking; the
 * widget says back which of its buttons was pressed. Both are parsed here, so
 * the rule for each is one schema the main process and the tests share.
 */

// The tree-shaken build of zod: the widget's page reads this module.
import * as z from "zod/mini";

/** The most people the page may list; the widget draws fewer and counts the rest. */
export const MAX_PEOPLE = 50;
/** The most rows the widget draws before it says how many more there are. */
export const MAX_ROWS = 8;

/**
 * The keys that lock and unlock the widget, tried in order, each with the name
 * the widget shows for it. Shift and the key under Esc, as Discord's overlay
 * has it - but only while a game runs: held system-wide the rest of the time
 * it would stop the computer typing the character on that key (`~` on a US
 * keyboard). The same with Ctrl (Cmd on a Mac) always, which nobody types,
 * and which also serves where Discord already holds the first.
 */
export function lockKeys(platform: NodeJS.Platform, inGame: boolean): readonly (readonly [accelerator: string, label: string])[] {
    const withCtrl = ["CommandOrControl+Shift+`", platform === "darwin" ? "Cmd+Shift+`" : "Ctrl+Shift+`"] as const;
    return inGame ? [["Shift+`", "Shift+`"], withCtrl] : [withCtrl];
}

const personSchema = z.strictObject({
    id: z.string().check(z.minLength(1), z.maxLength(128)),
    name: z.string().check(z.trim(), z.maxLength(120)),
    speaking: z.boolean(),
    muted: z.boolean(),
    deafened: z.boolean()
});

/** What the page in a call publishes, or null once it has ended. */
export const voiceStateSchema = z.nullable(
    z.strictObject({
        participants: z.array(personSchema).check(z.maxLength(MAX_PEOPLE)),
        selfMuted: z.boolean(),
        selfDeafened: z.boolean()
    })
);

export type VoiceState = z.infer<typeof voiceStateSchema>;
export type VoicePerson = z.infer<typeof personSchema>;

/** A press on the widget, handed to the page as its own call keys are. */
export const voiceActionSchema = z.enum(["mic", "deafen", "leave"]);

export type VoiceAction = z.infer<typeof voiceActionSchema>;

/** What the widget window is told to draw. */
export interface WidgetView {
    readonly state: NonNullable<VoiceState>;
    /** Unlocked: it takes clicks, shows its buttons and can be dragged. */
    readonly unlocked: boolean;
    /** The key that locks it again, or null when no key could be held. */
    readonly lockKey: string | null;
}

/** Whether the widget is on screen: only in a call, only when switched on, and
 *  - when somebody asked for that - only while a game is running. */
export function widgetVisible(input: {
    readonly inCall: boolean;
    readonly enabled: boolean;
    readonly onlyWithGame: boolean;
    readonly gameRunning: boolean;
}): boolean {
    return input.inCall && input.enabled && (!input.onlyWithGame || input.gameRunning);
}

export const WIDGET_WIDTH = 240;
const ROW_HEIGHT = 34;
const PADDING = 16;
const FOOTER_HEIGHT = 44;
const MORE_HEIGHT = 22;

/** The window's height for this many people: rows, the "and N more" line, and
 *  the buttons while it is unlocked. */
export function widgetHeight(people: number, unlocked: boolean): number {
    const rows = Math.min(Math.max(people, 1), MAX_ROWS);
    return PADDING + rows * ROW_HEIGHT + (people > MAX_ROWS ? MORE_HEIGHT : 0) + (unlocked ? FOOTER_HEIGHT : 0);
}

/** Up to two letters for a face with no picture. */
export function initials(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return "?";
    const letters = words.length === 1 ? [...words[0]!].slice(0, 2) : [[...words[0]!][0], [...words[words.length - 1]!][0]];
    return letters.join("").toUpperCase();
}

const HUES = [210, 262, 330, 20, 45, 150, 180, 0] as const;

/** The same color for the same person every time. */
export function faceColor(id: string): string {
    let hash = 0;
    for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return `hsl(${HUES[hash % HUES.length]} 55% 45%)`;
}
