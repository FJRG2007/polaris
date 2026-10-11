/**
 * Variables in a kept console command: `give {player} {item} {amount}`.
 *
 * Two sources, one syntax. The catalogue the announcements and the side panel
 * use (`text-vars`) - `{player}`, `{server.online}` - and the person's own,
 * declared on the command with a label, a type and a default, and asked for when
 * it is run. Read by the one parser in `text-vars`, and only names that are
 * known here are ever replaced: `summon minecraft:skeleton_horse ~ ~ ~
 * {SkeletonTrap:1b}` keeps its braces because `SkeletonTrap:1b` is not a name
 * either list holds.
 *
 * A value somebody types is checked before it is written into a command, by the
 * same schema on the screen and on the server: one line, bounded, and nothing
 * that could close a quote or a brace the command opened and start a command of
 * its own.
 *
 * Pure, so the dialog, the action that runs a command and the sweep that runs a
 * scheduled one cannot disagree about what a command means.
 */

import { z } from "zod";
import { gameMessage } from "./game-message";
import { playerSelector } from "./minecraft/announcement";
import type { MinecraftEdition } from "./minecraft/service";
import {
    LEVELS_VARIABLE,
    RANK_VARIABLES,
    VARIABLES,
    replaceVariables,
    variable,
    variablesIn,
    type VariableSpec,
    type VariableValues
} from "./minecraft/text-vars";

export type CustomVariableType = "text" | "number" | "player" | "item";

export const CUSTOM_VARIABLE_TYPES: readonly CustomVariableType[] = [
    "text",
    "number",
    "player",
    "item"
];

/** One variable somebody declared on a kept command. */
export interface CustomVariable {
    /** As written in the command, without the braces: `amount` for `{amount}`. */
    readonly name: string;
    /** What the run dialog asks. Falls back to the name. */
    readonly label: string;
    readonly type: CustomVariableType;
    /** What the run dialog starts with. May be empty. */
    readonly initial: string;
}

export const MAX_CUSTOM_VARIABLES = 8;
export const MAX_VARIABLE_LABEL = 40;
/** Long enough for a sentence in `say`, short enough that no value can push a
 *  command past what the console takes. */
export const MAX_VARIABLE_VALUE = 100;
/** How many players one "every player online" run writes a line for. */
export const MAX_PLAYER_LINES = 100;

const CUSTOM_NAME = /^[a-z][a-z0-9_]{0,23}$/;

/** The leaderboards and "everybody's level" ask the game itself for figures,
 *  which a one-line command has no place to wait for. */
const READ_FROM_GAME = new Set<string>([LEVELS_VARIABLE, ...RANK_VARIABLES]);

/** The catalogue variables a kept command can use on this server: Minecraft
 *  only, the ones its edition draws, and of the per-player ones only the name -
 *  a level or a health is drawn by the game in a text, not typed into a command. */
export function consoleVariables(edition: MinecraftEdition | null): VariableSpec[] {
    if (!edition) return [];
    return VARIABLES.filter(
        (spec) =>
            (edition === "java" || spec.bedrock) &&
            (spec.kind !== "game" || spec.name === "player") &&
            !READ_FROM_GAME.has(spec.name)
    );
}

function consoleSpec(name: string, edition: MinecraftEdition | null): VariableSpec | null {
    const spec = variable(name);
    return spec && consoleVariables(edition).some((offered) => offered.name === spec.name)
        ? spec
        : null;
}

function customOf(name: string, custom: readonly CustomVariable[]): CustomVariable | null {
    const key = name.toLowerCase();
    return custom.find((declared) => declared.name === key) ?? null;
}

/** What a command uses, of everything it could. */
export interface CommandUses {
    /** `{player}` or an account value: a line per player. */
    readonly perPlayer: boolean;
    /** Any catalogue variable at all: the server has to fill it in. */
    readonly catalogue: boolean;
    /** The declared ones it uses, in the order they are declared. */
    readonly custom: readonly CustomVariable[];
}

export function commandUses(
    command: string,
    edition: MinecraftEdition | null,
    custom: readonly CustomVariable[]
): CommandUses {
    const uses = variablesIn(command);
    const specs = uses.flatMap((use) => {
        if (customOf(use.name, custom)) return [];
        const spec = consoleSpec(use.name, edition);
        return spec ? [spec] : [];
    });
    const named = new Set(uses.map((use) => use.name.toLowerCase()));
    return {
        perPlayer: specs.some((spec) => spec.kind !== "server"),
        catalogue: specs.length > 0,
        custom: custom.filter((declared) => named.has(declared.name))
    };
}

/** Whether pressing it needs the server to fill something in, rather than
 *  sending it as it stands. */
export function hasVariables(
    command: string,
    edition: MinecraftEdition | null,
    custom: readonly CustomVariable[]
): boolean {
    const uses = commandUses(command, edition, custom);
    return uses.catalogue || uses.custom.length > 0;
}

/** Whether pressing it has to ask something first: a value, or which player. */
export function needsAsking(
    command: string,
    edition: MinecraftEdition | null,
    custom: readonly CustomVariable[]
): boolean {
    const uses = commandUses(command, edition, custom);
    return uses.perPlayer || uses.custom.length > 0;
}

/** The one normalizer, on the screen and on the server: trimmed, and an item id
 *  lowercased the way the game writes it. */
export function normalizeValue(type: CustomVariableType, value: string): string {
    const trimmed = value.trim();
    return type === "item" ? trimmed.toLowerCase() : trimmed;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
/** Quotes, backslashes and brackets are how a value would close what the
 *  command opened - a JSON string, an SNBT compound - and write its own. */
const BREAKS_OUT = /["'\\{}[\]]/;
const NUMBER = /^-?\d{1,9}(?:\.\d{1,4})?$/;
const ITEM = /^(?:[a-z0-9_.-]{1,32}:)?[a-z0-9_./-]{1,64}$/;

/** What is wrong with a value already normalized, as a carried message, or null. */
export function valueProblem(type: CustomVariableType, value: string): string | null {
    if (value.length === 0) return gameMessage("games", "consoleVars.errors.required");
    if (value.length > MAX_VARIABLE_VALUE) {
        return gameMessage("games", "consoleVars.errors.tooLong", { count: MAX_VARIABLE_VALUE });
    }
    if (CONTROL.test(value) || BREAKS_OUT.test(value)) {
        return gameMessage("games", "consoleVars.errors.plain");
    }
    if (type === "number" && !NUMBER.test(value)) {
        return gameMessage("games", "consoleVars.errors.number");
    }
    if (type === "player" && playerSelector(value) === null) {
        return gameMessage("games", "consoleVars.errors.player");
    }
    if (type === "item" && !ITEM.test(value)) {
        return gameMessage("games", "consoleVars.errors.item");
    }
    return null;
}

/** One value as the schema reads it: normalized, then checked. */
export function valueSchema(type: CustomVariableType): z.ZodType<string, z.ZodTypeDef, unknown> {
    return z
        .string()
        .max(MAX_VARIABLE_VALUE * 4)
        .transform((value) => normalizeValue(type, value))
        .superRefine((value, context) => {
            const problem = valueProblem(type, value);
            if (problem) context.addIssue({ code: z.ZodIssueCode.custom, message: problem });
        });
}

/** Every declared value a command needs, keyed by name. Nothing else is taken. */
export function valuesSchema(
    custom: readonly CustomVariable[]
): z.ZodType<Record<string, string>, z.ZodTypeDef, unknown> {
    return z
        .object(
            Object.fromEntries(
                custom.map((declared) => [declared.name, valueSchema(declared.type)])
            )
        )
        .strict() as unknown as z.ZodType<Record<string, string>, z.ZodTypeDef, unknown>;
}

/** Who a per-player command is written for: everybody on, or one player. */
export type RunTarget = { readonly every: true } | { readonly player: string };

export const runTargetSchema = z.union([
    z.object({ every: z.literal(true) }).strict(),
    z.object({ player: valueSchema("player") }).strict()
]);

/**
 * The declared variables as they should be stored, or the reason they cannot be.
 *
 * Refused rather than repaired: a name the command does not use is a variable
 * that would be asked for and go nowhere, and one that shadows a catalogue name
 * would change what an existing `{player}` means.
 */
export function customVariablesProblem(
    command: string,
    custom: readonly CustomVariable[]
): string | null {
    if (custom.length > MAX_CUSTOM_VARIABLES) {
        return gameMessage("games", "consoleVars.errors.tooMany", { count: MAX_CUSTOM_VARIABLES });
    }
    const used = new Set(variablesIn(command).map((use) => use.name.toLowerCase()));
    const seen = new Set<string>();
    for (const declared of custom) {
        if (!CUSTOM_NAME.test(declared.name)) {
            return gameMessage("games", "consoleVars.errors.name");
        }
        if (variable(declared.name)) {
            return gameMessage("games", "consoleVars.errors.taken", { name: declared.name });
        }
        if (seen.has(declared.name)) {
            return gameMessage("games", "consoleVars.errors.twice", { name: declared.name });
        }
        seen.add(declared.name);
        if (!used.has(declared.name)) {
            return gameMessage("games", "consoleVars.errors.unused", { name: declared.name });
        }
        if (declared.initial.length > 0) {
            const problem = valueProblem(
                declared.type,
                normalizeValue(declared.type, declared.initial)
            );
            if (problem) return problem;
        }
    }
    return null;
}

/** A declared variable as it was typed, cleaned the way it is stored. */
export function normalizeCustomVariable(input: {
    name: string;
    label?: string | null;
    type: CustomVariableType;
    initial?: string | null;
}): CustomVariable {
    const name = input.name
        .trim()
        .replace(/^\{|\}$/g, "")
        .trim()
        .toLowerCase();
    const label = (input.label ?? "")
        .replace(/[\0\r\n]/g, " ")
        .trim()
        .slice(0, MAX_VARIABLE_LABEL);
    return {
        name,
        label: label.length > 0 ? label : name,
        type: input.type,
        initial: normalizeValue(input.type, input.initial ?? "")
    };
}

/** The stored list, with anything unreadable dropped. */
export function readCustomVariables(raw: unknown): CustomVariable[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry): CustomVariable[] => {
        if (typeof entry !== "object" || entry === null) return [];
        const row = entry as Record<string, unknown>;
        if (typeof row.name !== "string" || !CUSTOM_VARIABLE_TYPES.includes(row.type as never)) {
            return [];
        }
        const declared = normalizeCustomVariable({
            name: row.name,
            label: typeof row.label === "string" ? row.label : null,
            type: row.type as CustomVariableType,
            initial: typeof row.initial === "string" ? row.initial : null
        });
        return CUSTOM_NAME.test(declared.name) ? [declared] : [];
    });
}

/** A value the server or the game handed over, made safe to sit in a command:
 *  the same characters a typed value may not hold are taken out. */
function commandSafe(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f"'\\{}[\]]/g, "").trim();
}

/** Everything a command is filled in with, already checked. */
export interface FillValues {
    readonly edition: MinecraftEdition | null;
    readonly custom: readonly CustomVariable[];
    /** The declared values, as `valuesSchema` returned them. */
    readonly values: Readonly<Record<string, string>>;
    /** The server's catalogue values (`server.name`...). */
    readonly server: VariableValues;
}

/**
 * One command with every variable it uses written in, for one player or none.
 * A per-player variable with no player to fill it is left as written - the
 * caller decides the players before it fills.
 */
export function fillCommand(
    command: string,
    fill: FillValues,
    player: { readonly name: string; readonly values: VariableValues } | null
): string {
    return replaceVariables(command, (use) => {
        const declared = customOf(use.name, fill.custom);
        if (declared) {
            const value = fill.values[declared.name];
            if (value === undefined) return null;
            return declared.type === "player" ? (playerSelector(value) ?? null) : value;
        }
        const spec = consoleSpec(use.name, fill.edition);
        if (!spec) return null;
        if (spec.name === "player") return player ? playerSelector(player.name) : null;
        const known = spec.kind === "account" ? player?.values[spec.name] : fill.server[spec.name];
        return commandSafe(known ?? use.fallback ?? "");
    });
}

/**
 * The lines one press sends: one, or one per player when the command is written
 * per player. Names a command cannot aim at are left out rather than sent broken.
 */
export function commandLines(
    command: string,
    fill: FillValues,
    players: readonly { readonly name: string; readonly values: VariableValues }[]
): string[] {
    if (!commandUses(command, fill.edition, fill.custom).perPlayer) {
        return [fillCommand(command, fill, null)];
    }
    return players
        .filter((player) => playerSelector(player.name) !== null)
        .slice(0, MAX_PLAYER_LINES)
        .map((player) => fillCommand(command, fill, player));
}
