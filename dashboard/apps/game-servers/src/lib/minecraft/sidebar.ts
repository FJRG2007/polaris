/**
 * The side panel: the box on the right of every player's screen, written by
 * Polaris - a title and up to fifteen lines, such as who is online or who is in
 * the call of a chat group - and kept current while the server runs.
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
import { usesPerPlayer, variableProblem, visibleLength } from "./text-vars";

/** Where it lives on the install's settings. */
export const SIDEBAR_KEY = "sidebar";

/** What the game draws: fifteen lines at most, and a panel as wide as its widest. */
export const SIDEBAR_LINES_MAX = 15;
export const SIDEBAR_LINE_MAX = 40;
export const SIDEBAR_TITLE_MAX = 32;

export const SIDEBAR_OBJECTIVE = "polaris_side";

export interface SidebarConfig {
    readonly enabled: boolean;
    /** Formatted text, `&` codes and all, like an announcement's title. */
    readonly title: string;
    readonly lines: readonly string[];
}

export const DEFAULT_SIDEBAR: SidebarConfig = {
    enabled: false,
    title: "&6&lPolaris",
    lines: ["Online: &a{server.online}&7/{server.max}", "", '{server.players | "Nobody yet"}']
};

const text = (max: number) =>
    z
        .string()
        .max(max * 4)
        .refine((value) => !/[\0\r\n]/.test(value), "One line each");

export const sidebarSchema = z.object({
    enabled: z.boolean(),
    title: text(SIDEBAR_TITLE_MAX),
    lines: z.array(text(SIDEBAR_LINE_MAX)).max(SIDEBAR_LINES_MAX)
});

/** The stored panel, or the default for a server that never had one. */
export function readSidebar(config: Record<string, unknown>): SidebarConfig {
    const parsed = sidebarSchema.safeParse(config[SIDEBAR_KEY]);
    return parsed.success ? parsed.data : DEFAULT_SIDEBAR;
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

/** What is wrong with one line of the panel, or null. */
function lineProblem(value: string, max: number): string | null {
    if (usesPerPlayer(value)) {
        return "The panel is the same for everybody: only {server.*} and {call.*} go on it";
    }
    const wrong = variableProblem(value, "java");
    if (wrong) return wrong;
    if (visibleLength(stripMotd(value)) > max) return `At most ${max} characters`;
    return null;
}

/** Problems by field, for under each one; empty when it can be saved. */
export function sidebarProblems(sidebar: SidebarConfig): {
    title?: string;
    lines: (string | null)[];
    count?: string;
} {
    const title = lineProblem(sidebar.title, SIDEBAR_TITLE_MAX);
    const lines = sidebar.lines.map((line) => lineProblem(line, SIDEBAR_LINE_MAX));
    const count =
        sidebar.lines.length > SIDEBAR_LINES_MAX
            ? `At most ${SIDEBAR_LINES_MAX} lines`
            : sidebar.enabled && sidebar.lines.length === 0
              ? "Add a line for the panel to show"
              : undefined;
    return { ...(title ? { title } : {}), lines, ...(count ? { count } : {}) };
}

export function hasSidebarProblems(sidebar: SidebarConfig): boolean {
    const found = sidebarProblems(sidebar);
    return Boolean(found.title || found.count || found.lines.some(Boolean));
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
