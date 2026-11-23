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
    deafened: z.boolean(),
    // Their face, as a path on the Polaris the call is on. Absent for a guest,
    // and from a page older than it.
    picture: z.optional(z.string().check(z.minLength(1), z.maxLength(512)))
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
    readonly look: WidgetLook;
    /** Which edge the rows sit against: the bottom for a widget in a bottom corner. */
    readonly anchor: "top" | "bottom";
    /** Each face fetched so far, by person id, as a data URL. Sent only when one
     *  arrived since the last view; a view without it keeps the ones it had. */
    readonly faces?: Readonly<Record<string, string>>;
}

/*
 * How the widget looks, chosen in the app's settings: the options Discord's
 * overlay voice widget has (avatar size, when names and people show, opacity)
 * and the corner it starts in.
 */
export const AVATAR_SIZES = ["large", "small"] as const;
export const NAME_MODES = ["always", "speaking", "never"] as const;
export const PEOPLE_MODES = ["always", "speaking"] as const;
export const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
export const OPACITIES = [100, 80, 60, 40] as const;

export type AvatarSize = (typeof AVATAR_SIZES)[number];
export type NameMode = (typeof NAME_MODES)[number];
export type PeopleMode = (typeof PEOPLE_MODES)[number];
export type Corner = (typeof CORNERS)[number];
export type Opacity = (typeof OPACITIES)[number];

export interface WidgetLook {
    readonly avatars: AvatarSize;
    readonly names: NameMode;
    readonly people: PeopleMode;
    readonly opacity: Opacity;
    readonly corner: Corner;
}

/** Discord's own defaults: large faces, every name, everybody, fully opaque. */
export const DEFAULT_LOOK: WidgetLook = { avatars: "large", names: "always", people: "always", opacity: 100, corner: "top-left" };

const opacitySchema = z.union([z.literal(100), z.literal(80), z.literal(60), z.literal(40)]);

/** One choice changed, as the settings page sends it. */
export const lookChangeSchema = z.union([
    z.strictObject({ key: z.literal("avatars"), value: z.enum(AVATAR_SIZES) }),
    z.strictObject({ key: z.literal("names"), value: z.enum(NAME_MODES) }),
    z.strictObject({ key: z.literal("people"), value: z.enum(PEOPLE_MODES) }),
    z.strictObject({ key: z.literal("opacity"), value: opacitySchema }),
    z.strictObject({ key: z.literal("corner"), value: z.enum(CORNERS) })
]);

export type LookChange = z.infer<typeof lookChangeSchema>;

/** The look with one choice changed. */
export function withLookChange(look: WidgetLook, change: LookChange): WidgetLook {
    return { ...look, [change.key]: change.value };
}

/** The people drawn: everybody, or - when that was chosen - only who is talking. */
export function shownPeople(participants: readonly VoicePerson[], look: Pick<WidgetLook, "people">): readonly VoicePerson[] {
    return look.people === "speaking" ? participants.filter((person) => person.speaking) : participants;
}

/** Whether a row shows its name: always, never, or only while they talk. */
export function showsName(person: Pick<VoicePerson, "speaking">, look: Pick<WidgetLook, "names">): boolean {
    return look.names === "always" || (look.names === "speaking" && person.speaking);
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

/** The window's width, in pixels at the default text size: room for a long
 *  name in its plate, and for the buttons while unlocked. */
export const WIDGET_WIDTH = 240;
/** The face and the row it sits in per avatar size, in pixels at the default
 *  text size - Discord's proportions: the plate hugs the name, the mute mark
 *  sits in it. */
export const ROW_METRICS = {
    large: { face: 32, row: 36 },
    small: { face: 22, row: 26 }
} as const satisfies Record<AvatarSize, { face: number; row: number; }>;
const PADDING = 8;
const FOOTER_HEIGHT = 44;
const MORE_HEIGHT = 22;

/**
 * The window's size for this many people: rows, the "and N more" line, and the
 * buttons while it is unlocked. Sized for everybody even when only who talks is
 * drawn, so the window does not resize at every word; what is not drawn is
 * clear, and locked it lets clicks through. With no names it is as narrow as a
 * face; unlocked it is wide enough for its buttons.
 */
export function widgetSize(people: number, unlocked: boolean, look: Pick<WidgetLook, "avatars" | "names"> = DEFAULT_LOOK): { width: number; height: number; } {
    const metrics = ROW_METRICS[look.avatars];
    const rows = Math.min(Math.max(people, 1), MAX_ROWS);
    const height = PADDING + rows * metrics.row + (people > MAX_ROWS ? MORE_HEIGHT : 0) + (unlocked ? FOOTER_HEIGHT : 0);
    const width = unlocked || look.names !== "never" ? WIDGET_WIDTH : PADDING + metrics.face + PADDING;
    return { width, height };
}

/** The window's height for this many people. */
export function widgetHeight(people: number, unlocked: boolean, look: Pick<WidgetLook, "avatars" | "names"> = DEFAULT_LOOK): number {
    return widgetSize(people, unlocked, look).height;
}

/** Where a window of this size sits in a corner of a screen's work area. */
export function cornerPoint(
    area: { readonly x: number; readonly y: number; readonly width: number; readonly height: number; },
    size: { readonly width: number; readonly height: number; },
    corner: Corner,
    margin: number
): { x: number; y: number; } {
    const right = corner.endsWith("right");
    const bottom = corner.startsWith("bottom");
    return {
        x: right ? area.x + area.width - size.width - margin : area.x + margin,
        y: bottom ? area.y + area.height - size.height - margin : area.y + margin
    };
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
