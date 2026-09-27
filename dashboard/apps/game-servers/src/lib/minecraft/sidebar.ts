/**
 * The side panel: the box on the right of every player's screen, written by
 * Polaris - a title and up to fifteen lines, such as who is online or who is in
 * the call of the linked chat - and kept current while the server runs.
 *
 * It is the game's scoreboard sidebar. One objective, `polaris_side`, is shown
 * there; each line is a score holder with a display name, and the scores only
 * put the lines in order - their numbers are hidden. Both of those (display
 * names and hidden numbers) arrived in Java 1.20.3, which is why an older server
 * or Bedrock is told it cannot have one rather than shown a panel of numbers.
 *
 * The panel is the same for everybody, so only the server's own variables go on
 * it: `{player}` would have to be one player's.
 *
 * Pure: what is allowed and what is sent can be asserted without a server.
 */

import { z } from "zod";
import { stripMotd } from "./motd";
import { javaComponent } from "./announcement";
import type { MinecraftEdition } from "./service";
import { usesPerPlayer, variableProblem, visibleLength, type KnownValues } from "./text-vars";

/** Where it lives on the install's settings. */
export const SIDEBAR_KEY = "sidebar";

/** What the game draws: fifteen lines at most, and a panel as wide as its widest. */
export const SIDEBAR_LINES_MAX = 15;
export const SIDEBAR_LINE_MAX = 40;
export const SIDEBAR_TITLE_MAX = 32;

export const SIDEBAR_OBJECTIVE = "polaris_side";

/** What an effect does to a line, step by step. */
export const SIDEBAR_EFFECTS = [
    "none",
    "rainbow",
    "wave",
    "shine",
    "typewriter",
    "blink",
    "scroll"
] as const;

export type SidebarEffectKind = (typeof SIDEBAR_EFFECTS)[number];

/** How long one step of an effect lasts. Not shorter: every step is a command to
 *  the server, and half a second is already twice a second for as long as it runs. */
export const SIDEBAR_SPEEDS = [500, 1000, 2000] as const;

export type SidebarSpeed = (typeof SIDEBAR_SPEEDS)[number];

export interface SidebarEffect {
    readonly kind: SidebarEffectKind;
    readonly speed: SidebarSpeed;
    /** The effect's own colours, `#rrggbb`: the shine's glint, the wave's two
     *  ends, the blink's dim. Unused by the ones that keep the line's own. */
    readonly colors: readonly string[];
    /** How many characters a scrolling line shows at once. */
    readonly width: number;
}

/** One line of the panel, or its title. */
export interface SidebarLine {
    /** What it says. More than one and it takes turns, `every` seconds each -
     *  the way to show several leaderboards in the room of one. */
    readonly frames: readonly string[];
    readonly every: number;
    readonly effect: SidebarEffect;
}

export interface SidebarConfig {
    readonly enabled: boolean;
    /** Formatted text, `&` codes and all, like an announcement's title. */
    readonly title: SidebarLine;
    readonly lines: readonly SidebarLine[];
}

/** The most texts one line takes turns between. */
export const SIDEBAR_FRAMES_MAX = 32;
/** How long a turn lasts, in seconds, at least and at most. */
export const SIDEBAR_EVERY_MIN = 2;
export const SIDEBAR_EVERY_MAX = 600;
export const SIDEBAR_EVERY_DEFAULT = 5;
/** How long a scrolling line may be: it shows `width` of it at a time. */
export const SIDEBAR_SCROLL_MAX = 120;

export const NO_EFFECT: SidebarEffect = { kind: "none", speed: 1000, colors: [], width: 20 };

/** A line that says one thing and does nothing else. */
export function plainLine(text: string): SidebarLine {
    return { frames: [text], every: SIDEBAR_EVERY_DEFAULT, effect: NO_EFFECT };
}

export const DEFAULT_SIDEBAR: SidebarConfig = {
    enabled: false,
    title: plainLine("&6&lPolaris"),
    lines: [
        plainLine("Online: &a{server.online}&7/{server.max}"),
        plainLine(""),
        plainLine('{server.players | "Nobody yet"}')
    ]
};

const text = (max: number) =>
    z
        .string()
        .max(max * 4)
        .refine((value) => !/[\0\r\n]/.test(value), "One line each");

const effectSchema = z.object({
    kind: z.enum(SIDEBAR_EFFECTS),
    speed: z.union([z.literal(500), z.literal(1000), z.literal(2000)]),
    colors: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).max(4),
    width: z.number().int().min(8).max(SIDEBAR_LINE_MAX)
});

/** A line as stored. A panel saved before lines could take turns or move holds
 *  plain strings, and reads as the same panel. */
const lineSchema = (max: number) =>
    z.preprocess(
        (value) => (typeof value === "string" ? plainLine(value) : value),
        z.object({
            frames: z.array(text(max)).min(1).max(SIDEBAR_FRAMES_MAX),
            every: z.number().int().min(SIDEBAR_EVERY_MIN).max(SIDEBAR_EVERY_MAX),
            effect: effectSchema
        })
    );

export const sidebarSchema = z.object({
    enabled: z.boolean(),
    title: lineSchema(SIDEBAR_SCROLL_MAX),
    lines: z.array(lineSchema(SIDEBAR_SCROLL_MAX)).max(SIDEBAR_LINES_MAX)
});

/** The stored panel, or the default for a server that never had one. */
export function readSidebar(config: Record<string, unknown>): SidebarConfig {
    const parsed = sidebarSchema.safeParse(config[SIDEBAR_KEY]);
    return parsed.success ? parsed.data : DEFAULT_SIDEBAR;
}

/** Which of a line's texts is up at `now`. Every line with the same period turns
 *  at the same moment, so a heading and the list under it change together. */
export function frameAt(line: SidebarLine, now: number): string {
    const frames = line.frames.length > 0 ? line.frames : [""];
    const turn = Math.floor(now / (line.every * 1000));
    return frames[((turn % frames.length) + frames.length) % frames.length] ?? "";
}

/** Whether anything on the panel moves by itself, and how often it has to be
 *  drawn again for that: the shortest step of any effect, or of any turn. */
export function animationPeriod(sidebar: SidebarConfig): number | null {
    let shortest: number | null = null;
    for (const line of [sidebar.title, ...sidebar.lines]) {
        if (line.effect.kind !== "none")
            shortest = Math.min(shortest ?? Infinity, line.effect.speed);
        if (line.frames.length > 1) shortest = Math.min(shortest ?? Infinity, line.every * 1000);
    }
    return shortest;
}

/** Every text on the panel, every turn of every line, for reading the values
 *  they need in one go. */
export function sidebarTexts(sidebar: SidebarConfig): string[] {
    return [sidebar.title, ...sidebar.lines].flatMap((line) => line.frames);
}

/** Whether this server can draw the panel: Java 1.20.3 or newer. A server on
 *  "latest" has no release recorded, and is. */
export function sidebarSupported(edition: MinecraftEdition, release: string | null): boolean {
    if (edition === "bedrock") return false;
    if (!release) return true;
    const [major = 0, minor = 0, patch = 0] = release.split(".").map((part) => Number(part) || 0);
    if (major !== 1) return major > 1;
    if (minor !== 20) return minor > 20;
    return patch >= 3;
}

/** Why the panel cannot be switched on here, or null. */
export function sidebarRefusal(edition: MinecraftEdition, release: string | null): string | null {
    if (edition === "bedrock") return "Bedrock has no side panel Polaris can write to";
    if (!sidebarSupported(edition, release)) {
        return "The side panel needs Minecraft 1.20.3 or newer on this server";
    }
    return null;
}

/** What is wrong with one text of the panel, or null. */
function textProblem(value: string, max: number, known: KnownValues): string | null {
    if (usesPerPlayer(value)) {
        return "The panel is the same for everybody: only {server.*} and {call.*} go on it";
    }
    const wrong = variableProblem(value, "java");
    if (wrong) return wrong;
    if (visibleLength(stripMotd(value), known) > max) return `At most ${max} characters`;
    return null;
}

/** How long each text of a line may be: what fits across the panel, or more for
 *  one that scrolls through a window of it. */
export function textMax(line: SidebarLine, fits: number): number {
    return line.effect.kind === "scroll" ? SIDEBAR_SCROLL_MAX : fits;
}

/** Problems by field, for under each one - one per text of a line - and empty
 *  when it can be saved. `known` is what the server's values already are. */
export function sidebarProblems(
    sidebar: SidebarConfig,
    known: KnownValues = {}
): {
    title: (string | null)[];
    lines: (string | null)[][];
    count?: string;
} {
    const of = (line: SidebarLine, fits: number) =>
        line.frames.map((frame) => textProblem(frame, textMax(line, fits), known));
    const title = of(sidebar.title, SIDEBAR_TITLE_MAX);
    const lines = sidebar.lines.map((line) => of(line, SIDEBAR_LINE_MAX));
    const count =
        sidebar.lines.length > SIDEBAR_LINES_MAX
            ? `At most ${SIDEBAR_LINES_MAX} lines`
            : sidebar.enabled && sidebar.lines.length === 0
              ? "Add a line for the panel to show"
              : undefined;
    return { title, lines, ...(count ? { count } : {}) };
}

export function hasSidebarProblems(sidebar: SidebarConfig, known: KnownValues = {}): boolean {
    const found = sidebarProblems(sidebar, known);
    return Boolean(
        found.count || found.title.some(Boolean) || found.lines.some((line) => line.some(Boolean))
    );
}

/** The score holder behind line `index`. Never a player's name: a dot is not
 *  allowed in one. */
function holder(index: number): string {
    return `polaris.line.${String(index + 1).padStart(2, "0")}`;
}

/**
 * The commands that make the panel read `title` and `lines`, already filled in,
 * given what it read last time (`shown`, or null when nothing of Polaris's is
 * on screen). Only what changed is sent, so a panel that ticks over every few
 * seconds costs a command or two rather than twenty.
 */
export function sidebarCommands(
    title: string,
    lines: readonly string[],
    shown: { readonly title: string; readonly lines: readonly string[] } | null
): string[] {
    const commands: string[] = [];
    const heading = javaComponent(title, false);
    if (!shown) {
        // Taken down first: a panel left from before Polaris restarted may hold
        // more lines than this one, and nothing here remembers how many.
        commands.push(
            ...sidebarOffCommands(),
            `scoreboard objectives add ${SIDEBAR_OBJECTIVE} dummy ${heading}`,
            `scoreboard objectives modify ${SIDEBAR_OBJECTIVE} numberformat blank`,
            `scoreboard objectives setdisplay sidebar ${SIDEBAR_OBJECTIVE}`
        );
    }
    if (!shown || shown.title !== title) {
        commands.push(`scoreboard objectives modify ${SIDEBAR_OBJECTIVE} displayname ${heading}`);
    }
    const before = shown?.lines ?? [];
    lines.forEach((line, index) => {
        // Higher scores sit higher, so the first line gets the most.
        const order = lines.length - index;
        if (before.length !== lines.length || !shown) {
            commands.push(`scoreboard players set ${holder(index)} ${SIDEBAR_OBJECTIVE} ${order}`);
        }
        if (before[index] !== line || !shown) {
            commands.push(
                `scoreboard players display name ${holder(index)} ${SIDEBAR_OBJECTIVE} ${javaComponent(line, false)}`
            );
        }
    });
    for (let index = lines.length; index < before.length; index += 1) {
        commands.push(`scoreboard players reset ${holder(index)} ${SIDEBAR_OBJECTIVE}`);
    }
    return commands;
}

/** Take the panel off every screen. */
export function sidebarOffCommands(): string[] {
    return [`scoreboard objectives remove ${SIDEBAR_OBJECTIVE}`];
}
