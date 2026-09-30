/**
 * The commands challenges are played with.
 *
 * Only reads and gifts: scoreboard objectives that count statistics (every name
 * starts with `pc_`, so taking them down never touches anything else), the one
 * `trigger` objective the menu's buttons press, `clear <player> <item> 0` which
 * counts what somebody holds and removes nothing, advancement tests, titles, the
 * action bar, boss bars, a sound - and `give` and `xp add` for rewards. Nothing
 * here places or breaks a block, kills an entity or takes an item or a level.
 *
 * Pure, so every line is asserted in a test, and none is longer than the
 * console tool sends (`COMMAND_BYTES_MAX`).
 */

import { asciiJson, text } from "../events/commands";
import { COMMAND_BYTES_MAX, commandBytes } from "../command-size";

/** A player's name as a command may carry it: Java's, or Floodgate's `.` in
 *  front of a Bedrock player's. Anything else is never put into a command. */
export const PLAYER_NAME = /^\.?[A-Za-z0-9_]{1,16}$/;

/** The menu's buttons: `/trigger pc_menu set <value>`. */
export const MENU = "pc_menu";

export const PRESS = {
    list: 1,
    season: 2,
    card: 3,
    goal: 4,
    untrack: 5,
    /** + slot: daily 0-2, weekly 3-5. */
    reroll: 10,
    /** + slot: daily 0-2, weekly 3-5, backlog 6-8. */
    track: 20,
    /** + square 0-8. */
    trackSquare: 30,
    /** + goal 0-4. */
    trackGoal: 40
} as const;

/** Which click and hover spellings a server reads: `clickEvent` before 1.21.5,
 *  `click_event` from it. Unknown: both, each version ignoring the other's. */
export type Spelling = "legacy" | "modern" | "both";

export function spellingFor(
    version: string | null,
    atLeast: (wanted: readonly number[]) => boolean
): Spelling {
    if (version === null) return "both";
    return atLeast([1, 21, 5]) ? "modern" : "legacy";
}

/** Formatted text as the game's JSON parts. */
export function parts(line: string): unknown[] {
    const parsed = JSON.parse(text(line)) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
}

/** A clickable button that presses the menu trigger. */
export function button(
    label: string,
    hover: string,
    value: number,
    color: string,
    spelling: Spelling
): Record<string, unknown> {
    const command = `/trigger ${MENU} set ${value}`;
    const hoverParts = parts(hover);
    const hoverText = hoverParts.length === 1 ? hoverParts[0] : ["", ...hoverParts];
    return {
        text: label,
        color,
        bold: true,
        underlined: true,
        ...(spelling !== "modern"
            ? {
                  clickEvent: { action: "run_command", value: command },
                  hoverEvent: { action: "show_text", contents: hoverText }
              }
            : {}),
        ...(spelling !== "legacy"
            ? {
                  click_event: { action: "run_command", command },
                  hover_event: { action: "show_text", value: hoverText }
              }
            : {})
    };
}

/** A line to one player, of text and buttons. */
export function tellraw(player: string, pieces: readonly unknown[]): string {
    return `tellraw ${player} ${asciiJson(JSON.stringify(["", ...pieces]))}`;
}

export function tell(player: string, line: string): string {
    return `tellraw ${player} ${text(line)}`;
}

/**
 * Lines of pieces to one player, each kept under what the console tool sends:
 * a line that would be too long is split at its pieces, and a single piece too
 * long on its own is dropped rather than sent to vanish.
 */
export function fitted(player: string, pieces: readonly unknown[]): string[] {
    const whole = tellraw(player, pieces);
    if (commandBytes(whole) <= COMMAND_BYTES_MAX) return [whole];
    const lines: string[] = [];
    let current: unknown[] = [];
    for (const piece of pieces) {
        const next = tellraw(player, [...current, piece]);
        if (commandBytes(next) <= COMMAND_BYTES_MAX) {
            current.push(piece);
            continue;
        }
        if (current.length > 0) lines.push(tellraw(player, current));
        current = commandBytes(tellraw(player, [piece])) <= COMMAND_BYTES_MAX ? [piece] : [];
    }
    if (current.length > 0) lines.push(tellraw(player, current));
    return lines;
}

// ------------------------------------------------------------------ objectives

/** A statistic counted from now for everybody: made again, so it starts at 0. */
export function addObjectives(objectives: Readonly<Record<string, string>>): string[] {
    return Object.entries(objectives).flatMap(([criterion, name]) => [
        `scoreboard objectives remove ${name}`,
        `scoreboard objectives add ${name} ${criterion}`
    ]);
}

export function removeObjectives(names: readonly string[]): string[] {
    return names.map((name) => `scoreboard objectives remove ${name}`);
}

export const LIST_OBJECTIVES = "scoreboard objectives list";

/** Every score one player has, online or not. */
export function listScores(player: string): string {
    return `scoreboard players list ${player}`;
}

/** The menu's trigger, and everybody allowed to press it - again after each
 *  press, since the game takes the permission away each time. */
export const MENU_SETUP = [
    `scoreboard objectives add ${MENU} trigger`,
    `scoreboard players enable @a ${MENU}`
];

export const READ_PRESSES = `execute as @a[scores={${MENU}=1..}] run scoreboard players get @s ${MENU}`;

export function pressHandled(player: string): string[] {
    return [
        `scoreboard players set ${player} ${MENU} 0`,
        `scoreboard players enable ${player} ${MENU}`
    ];
}

// ------------------------------------------------------------------ reading

/** How many of an item somebody holds; `0` removes nothing. */
export function heldCount(player: string, item: string): string {
    return `clear ${player} minecraft:${item} 0`;
}

/** Whether somebody has an advancement: `Test passed` or `Test failed`. */
export function hasAdvancement(player: string, id: string): string {
    return `execute if entity @a[name=${player},advancements={minecraft:${id}=true}]`;
}

// ------------------------------------------------------------------ showing

export function actionBar(player: string, line: string): string {
    return `title ${player} actionbar ${text(line)}`;
}

export function completion(player: string, title: string, subtitle: string): string[] {
    return [
        `title ${player} times 10 60 20`,
        `title ${player} subtitle ${text(subtitle)}`,
        `title ${player} title ${text(title)}`,
        `execute as ${player} at @s run playsound minecraft:ui.toast.challenge_complete master @s ~ ~ ~ 1 1`
    ];
}

/** A player's own boss bar for the challenge they track. */
export function trackedBar(player: string): string {
    return `polaris:pc_${player.toLowerCase()}`;
}

export function barShow(
    id: string,
    name: string,
    value: number,
    max: number,
    players: string,
    color: string
): string[] {
    const top = Math.max(1, Math.round(max));
    return [
        `bossbar add ${id} ${text(name)}`,
        `bossbar set ${id} name ${text(name)}`,
        `bossbar set ${id} color ${color}`,
        `bossbar set ${id} max ${top}`,
        `bossbar set ${id} value ${Math.max(0, Math.min(top, Math.round(value)))}`,
        `bossbar set ${id} players ${players}`,
        `bossbar set ${id} visible true`
    ];
}

export function barHide(id: string): string[] {
    return [`bossbar set ${id} visible false`];
}

export function barRemove(id: string): string {
    return `bossbar remove ${id}`;
}

export const GOAL_BAR = "polaris:pc_goal";

// ------------------------------------------------------------------ rewards

/** A reward for one player: only ever adds. */
export function giveLines(
    player: string,
    payout: { levels: number; items: readonly { id: string; count: number }[] }
): { items: string[]; levels: string | null } {
    return {
        items: payout.items.map((item) => `give ${player} ${item.id} ${item.count}`),
        levels: payout.levels > 0 ? `xp add ${player} ${payout.levels} levels` : null
    };
}

/** Whether a `give` or `xp add` reached somebody. */
export function arrived(output: string): boolean {
    return !/no player|not found|unknown|incorrect|expected|invalid|error/i.test(output);
}

/** Everything challenges keep on a server, taken down when they are switched off. */
export function teardown(objectives: readonly string[], bars: readonly string[]): string[] {
    return [
        ...removeObjectives(objectives),
        `scoreboard objectives remove ${MENU}`,
        ...bars.map((id) => barRemove(id)),
        barRemove(GOAL_BAR),
        barRemove(`${GOAL_BAR}2`)
    ];
}
