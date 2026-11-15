/**
 * Variables in a kept console command: `give {player} {item} {amount}`.
 *
 * Two sources, one syntax. The catalogue the announcements and the side panel
 * use (`text-vars`) - `{player}`, `{server.online}` - and the person's own,
 * declared on the command with a label, a type and a default, and asked for when
 * it is run. A variable may also be declared in the command itself: `{x}` asks
 * for a value, `{x=100}` asks with 100 filled in, and either is used as text
 * (or a number, when its default is one) unless the list declares it otherwise.
 * A run that leaves a value with a default empty is sent with the default. Read by the one parser in `text-vars`, and only names that are
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
    PLAYER_READS,
    RANK_VARIABLES,
    VARIABLES,
    replaceVariables,
    variable,
    variablesIn,
    type VariableSpec,
    type VariableValues
} from "./minecraft/text-vars";

export type CustomVariableType =
    "text" | "number" | "integer" | "coordinates" | "player" | "dimension" | "item";

export const CUSTOM_VARIABLE_TYPES: readonly CustomVariableType[] = [
    "text",
    "number",
    "integer",
    "coordinates",
    "player",
    "dimension",
    "item"
];

/** The types a smallest and a largest value apply to. */
export const BOUNDED_TYPES: readonly CustomVariableType[] = ["number", "integer"];

/** One variable somebody declared on a kept command. */
export interface CustomVariable {
    /** As written in the command, without the braces: `amount` for `{amount}`. */
    readonly name: string;
    /** What the run dialog asks. Falls back to the name. */
    readonly label: string;
    readonly type: CustomVariableType;
    /** What the run dialog starts with. May be empty. */
    readonly initial: string;
    /** For a number or a whole number: the smallest value it takes. */
    readonly min?: number;
    /** For a number or a whole number: the largest value it takes. */
    readonly max?: number;
    /** May be left empty with no default, and is then written as nothing.
     *  Absent on every variable declared before it existed: required. */
    readonly optional?: true;
}

/** The bounds a value is checked against, read off its variable. */
export type ValueLimits = Pick<CustomVariable, "min" | "max" | "optional">;

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
 *  only, the ones its edition draws, and of the per-player ones the name and
 *  whatever Polaris can ask the game for before the line goes (`player-read`):
 *  where they stand, their dimension, level and health. */
export function consoleVariables(edition: MinecraftEdition | null): VariableSpec[] {
    if (!edition) return [];
    return VARIABLES.filter(
        (spec) =>
            (edition === "java" || spec.bedrock) &&
            (spec.kind !== "game" || spec.name === "player" || spec.name in PLAYER_READS) &&
            !READ_FROM_GAME.has(spec.name)
    );
}

/** The per-player values a command asks the game for, by variable. */
export function playerReadsIn(command: string, edition: MinecraftEdition | null): string[] {
    const names = variablesIn(command).flatMap((use) => {
        const spec = consoleSpec(use.name, edition);
        return spec && spec.name in PLAYER_READS ? [spec.name] : [];
    });
    return [...new Set(names)];
}

function consoleSpec(name: string, edition: MinecraftEdition | null): VariableSpec | null {
    const spec = variable(name);
    return spec && consoleVariables(edition).some((offered) => offered.name === spec.name)
        ? spec
        : null;
}

/** `{name=default}`: a variable declared where it is used, with its default.
 *  The default holds no quote, backslash or bracket, so a brace of NBT data -
 *  `{CustomName:"x"}` - is never read as one. */
const INLINE = /\{\s*([a-z][a-z0-9_]{0,23})\s*=([^{}"'\\[\]\u0000-\u001f\u007f]{0,200})\}/g;

/** A command with every variable declared in it, read once. */
export interface CommandVariables {
    /** The command with `{name=default}` written back as `{name}`: what is
     *  filled in and sent. */
    readonly command: string;
    /** The declared list, then every variable the command declares itself, in
     *  the order it first appears. A listed variable keeps its label and type,
     *  and takes the command's default when it has none of its own. */
    readonly custom: readonly CustomVariable[];
}

/**
 * The variables a command asks for: the ones declared on it, and the ones it
 * declares itself (`{x}`, `{x=100}`). A name of the catalogue's is never taken
 * over - `{player=x}` is left as written - and only a lowercase name is, so a
 * brace of game data stays the game's.
 */
export function commandVariables(
    command: string,
    declared: readonly CustomVariable[]
): CommandVariables {
    const defaults = new Map<string, string>();
    const canonical = command.replace(INLINE, (raw, name: string, fallback: string) => {
        if (variable(name)) return raw;
        if (!defaults.has(name)) defaults.set(name, fallback.trim());
        return `{${name}}`;
    });
    const custom: CustomVariable[] = declared.map((one) => {
        const fallback = defaults.get(one.name);
        return one.initial.length === 0 && fallback
            ? { ...one, initial: normalizeValue(one.type, fallback) }
            : one;
    });
    for (const use of variablesIn(canonical)) {
        const name = use.name;
        if (use.fallback !== null || !CUSTOM_NAME.test(name) || variable(name)) continue;
        if (custom.some((one) => one.name === name)) continue;
        const fallback = defaults.get(name) ?? "";
        custom.push({
            name,
            label: name,
            type: NUMBER.test(fallback) ? "number" : "text",
            initial: fallback
        });
    }
    return { command: canonical, custom };
}

function customOf(name: string, custom: readonly CustomVariable[]): CustomVariable | null {
    const key = name.toLowerCase();
    return custom.find((declared) => declared.name === key) ?? null;
}

/** A declared variable a `{...}` writes: the whole of it, or for a position
 *  one axis of it - `{pos.x}`. */
function customUse(
    name: string,
    custom: readonly CustomVariable[]
): { readonly declared: CustomVariable; readonly axis: number | null } | null {
    const whole = customOf(name, custom);
    if (whole) return { declared: whole, axis: null };
    const match = /^(.+)\.([xyz])$/i.exec(name);
    if (!match) return null;
    const declared = customOf(match[1]!, custom);
    return declared?.type === "coordinates"
        ? { declared, axis: COORDINATE_AXES.indexOf(match[2]!.toLowerCase() as CoordinateAxis) }
        : null;
}

/** What a run fills a declared variable with: the typed value, or its default. */
function valueOf(declared: CustomVariable, values: Readonly<Record<string, string>>): string {
    const typed = values[declared.name];
    return typed === undefined || typed.length === 0 ? declared.initial : typed;
}

/**
 * Whether a run counts a position from where a player stands - a `~` in it -
 * so it needs a player to count from, and where they are read first.
 */
export function usesRelative(
    custom: readonly CustomVariable[],
    values: Readonly<Record<string, string>>
): boolean {
    return custom.some(
        (declared) =>
            declared.type === "coordinates" &&
            isRelative(normalizeValue("coordinates", valueOf(declared, values)))
    );
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
    const read = commandVariables(command, custom);
    custom = read.custom;
    const uses = variablesIn(read.command);
    const specs = uses.flatMap((use) => {
        if (customUse(use.name, custom)) return [];
        const spec = consoleSpec(use.name, edition);
        return spec ? [spec] : [];
    });
    const named = usedNames(read.command, custom);
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
    if (type === "item") return trimmed.toLowerCase();
    // `100, 64, -20` is how a position is copied out of most places; the game
    // reads three words.
    if (type === "coordinates") return trimmed.replace(/,/g, " ").replace(/\s+/g, " ").trim();
    if (type === "dimension") {
        const lowered = trimmed.toLowerCase();
        return DIMENSION_ALIASES[lowered] ?? lowered;
    }
    return trimmed;
}

/** The three the game ships with, by the names somebody will type for them. */
const DIMENSION_ALIASES: Readonly<Record<string, string>> = {
    overworld: "minecraft:overworld",
    nether: "minecraft:the_nether",
    the_nether: "minecraft:the_nether",
    end: "minecraft:the_end",
    the_end: "minecraft:the_end"
};

/** How far from the middle of the world a position may be: the game's own
 *  limits, past which it refuses the command anyway. */
export const HORIZONTAL_LIMIT = 30_000_000;
export const VERTICAL_LIMIT = 20_000_000;

export const COORDINATE_AXES = ["x", "y", "z"] as const;
export type CoordinateAxis = (typeof COORDINATE_AXES)[number];

/** One axis of a position: a number, or `~` and an offset from the player. */
export interface CoordinatePart {
    readonly relative: boolean;
    readonly amount: number;
}

const COORDINATE_PART = /^(~)?(-?\d{1,8}(?:\.\d{1,4})?)?$/;

/**
 * A position as typed - `100 64 -20`, `~ ~1 ~`, `~-5 70 ~` - read the way the
 * game reads one, or null when it is not one. Already normalized; within the
 * world's limits.
 */
export function readCoordinates(value: string): readonly CoordinatePart[] | null {
    const words = value.split(" ");
    if (words.length !== 3) return null;
    const parts: CoordinatePart[] = [];
    for (const [index, word] of words.entries()) {
        const match = COORDINATE_PART.exec(word);
        if (!match || (!match[1] && match[2] === undefined)) return null;
        const amount = match[2] === undefined ? 0 : Number(match[2]);
        const limit = index === 1 ? VERTICAL_LIMIT : HORIZONTAL_LIMIT;
        if (!Number.isFinite(amount) || Math.abs(amount) > limit) return null;
        parts.push({ relative: Boolean(match[1]), amount });
    }
    return parts;
}

/** Whether a position counts from where the player stands. */
export function isRelative(value: string): boolean {
    return readCoordinates(value)?.some((part) => part.relative) ?? false;
}

/** A coordinate as the game takes it: no trailing zeros, no float noise. */
function coordinateText(amount: number): string {
    return String(Number(amount.toFixed(4)));
}

/**
 * The three numbers a position stands for, with every `~` counted from
 * `origin` - where the player stands. Null when it counts from a player and
 * there is none, so a relative position is never quietly measured from where
 * the console sits.
 */
export function resolveCoordinates(
    value: string,
    origin: readonly [number, number, number] | null
): [string, string, string] | null {
    const parts = readCoordinates(value);
    if (!parts) return null;
    if (parts.some((part) => part.relative) && !origin) return null;
    const [x, y, z] = parts.map((part, index) =>
        coordinateText(part.relative ? (origin?.[index] ?? 0) + part.amount : part.amount)
    );
    return [x!, y!, z!];
}

const CONTROL = /[\u0000-\u001f\u007f]/;
/** Quotes, backslashes and brackets are how a value would close what the
 *  command opened - a JSON string, an SNBT compound - and write its own. */
const BREAKS_OUT = /["'\\{}[\]]/;
const NUMBER = /^-?\d{1,9}(?:\.\d{1,4})?$/;
const INTEGER = /^-?\d{1,9}$/;
const ITEM = /^(?:[a-z0-9_.-]{1,32}:)?[a-z0-9_./-]{1,64}$/;
const DIMENSION = /^[a-z0-9_.-]{1,32}:[a-z0-9_./-]{1,64}$/;

/** What is wrong with a value already normalized, as a carried message, or null. */
export function valueProblem(
    type: CustomVariableType,
    value: string,
    limits: ValueLimits = {}
): string | null {
    if (value.length === 0) {
        return limits.optional ? null : gameMessage("games", "consoleVars.errors.required");
    }
    if (value.length > MAX_VARIABLE_VALUE) {
        return gameMessage("games", "consoleVars.errors.tooLong", { count: MAX_VARIABLE_VALUE });
    }
    if (CONTROL.test(value) || BREAKS_OUT.test(value)) {
        return gameMessage("games", "consoleVars.errors.plain");
    }
    if (type === "number" && !NUMBER.test(value)) {
        return gameMessage("games", "consoleVars.errors.number");
    }
    if (type === "integer" && !INTEGER.test(value)) {
        return gameMessage("games", "consoleVars.errors.integer");
    }
    if (BOUNDED_TYPES.includes(type)) {
        const amount = Number(value);
        if (limits.min !== undefined && amount < limits.min) {
            return gameMessage("games", "consoleVars.errors.atLeast", { min: limits.min });
        }
        if (limits.max !== undefined && amount > limits.max) {
            return gameMessage("games", "consoleVars.errors.atMost", { max: limits.max });
        }
    }
    if (type === "coordinates" && !readCoordinates(value)) {
        return gameMessage("games", "consoleVars.errors.coordinates", {
            count: HORIZONTAL_LIMIT
        });
    }
    if (type === "dimension" && !DIMENSION.test(value)) {
        return gameMessage("games", "consoleVars.errors.dimension");
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
export function valueSchema(
    type: CustomVariableType,
    limits: ValueLimits = {}
): z.ZodType<string, z.ZodTypeDef, unknown> {
    return z
        .string()
        .max(MAX_VARIABLE_VALUE * 4)
        .transform((value) => normalizeValue(type, value))
        .superRefine((value, context) => {
            const problem = valueProblem(type, value, limits);
            if (problem) context.addIssue({ code: z.ZodIssueCode.custom, message: problem });
        });
}

/** One value as a run reads it: left empty or out, a variable with a default
 *  takes the default; one without still has to be filled in. */
export function runValueSchema(declared: CustomVariable): z.ZodType<string, z.ZodTypeDef, unknown> {
    const checked = valueSchema(declared.type, declared);
    if (declared.initial.length === 0) {
        if (!declared.optional) return checked;
        // An optional one left out is the same as one left empty.
        return z.preprocess((value) => (value === undefined ? "" : value), checked) as z.ZodType<
            string,
            z.ZodTypeDef,
            unknown
        >;
    }
    return z.preprocess(
        (value) =>
            value === undefined || (typeof value === "string" && value.trim().length === 0)
                ? declared.initial
                : value,
        checked
    ) as z.ZodType<string, z.ZodTypeDef, unknown>;
}

/** Every declared value a command needs, keyed by name. Nothing else is taken.
 *  Pass the list `commandVariables` reads, so the ones the command declares
 *  itself are asked for too. */
export function valuesSchema(
    custom: readonly CustomVariable[]
): z.ZodType<Record<string, string>, z.ZodTypeDef, unknown> {
    return z
        .object(
            Object.fromEntries(custom.map((declared) => [declared.name, runValueSchema(declared)]))
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
    const read = commandVariables(command, custom);
    if (read.custom.length > MAX_CUSTOM_VARIABLES) {
        return gameMessage("games", "consoleVars.errors.tooMany", { count: MAX_CUSTOM_VARIABLES });
    }
    const used = usedNames(read.command, read.custom);
    const seen = new Set<string>();
    for (const declared of read.custom) {
        if (!CUSTOM_NAME.test(declared.name)) {
            return gameMessage("games", "consoleVars.errors.name");
        }
        // A position named `death` would answer for `{death.x}`, which is
        // already Polaris's.
        const shadows =
            declared.type === "coordinates" &&
            COORDINATE_AXES.some((axis) => variable(`${declared.name}.${axis}`));
        if (variable(declared.name) || shadows) {
            return gameMessage("games", "consoleVars.errors.taken", { name: declared.name });
        }
        if (seen.has(declared.name)) {
            return gameMessage("games", "consoleVars.errors.twice", { name: declared.name });
        }
        seen.add(declared.name);
        if (!used.has(declared.name)) {
            return gameMessage("games", "consoleVars.errors.unused", { name: declared.name });
        }
        if (
            declared.min !== undefined &&
            declared.max !== undefined &&
            declared.min > declared.max
        ) {
            return gameMessage("games", "consoleVars.errors.range");
        }
        if (
            declared.type === "integer" &&
            [declared.min, declared.max].some(
                (bound) => bound !== undefined && !Number.isInteger(bound)
            )
        ) {
            return gameMessage("games", "consoleVars.errors.integer");
        }
        if (declared.initial.length > 0) {
            const problem = valueProblem(
                declared.type,
                normalizeValue(declared.type, declared.initial),
                declared
            );
            if (problem) return problem;
        }
    }
    return null;
}

/** The furthest a smallest or largest value may be set: what a number holds. */
export const BOUND_LIMIT = 999_999_999;

/** The variables a command writes, by name: `{pos.x}` writes `pos` when `pos`
 *  is a position. */
function usedNames(command: string, custom: readonly CustomVariable[]): Set<string> {
    return new Set(
        variablesIn(command).map(
            (use) => customUse(use.name, custom)?.declared.name ?? use.name.toLowerCase()
        )
    );
}

/** A declared variable as it was typed, cleaned the way it is stored. */
export function normalizeCustomVariable(input: {
    name: string;
    label?: string | null;
    type: CustomVariableType;
    initial?: string | null;
    min?: number | null;
    max?: number | null;
    optional?: boolean | null;
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
    // A bound only means something on a number, and one past what a number
    // holds is no bound at all.
    const bound = (value: number | null | undefined): number | undefined =>
        BOUNDED_TYPES.includes(input.type) &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        Math.abs(value) <= BOUND_LIMIT
            ? value
            : undefined;
    const min = bound(input.min);
    const max = bound(input.max);
    return {
        name,
        label: label.length > 0 ? label : name,
        type: input.type,
        initial: normalizeValue(input.type, input.initial ?? ""),
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(input.optional === true ? { optional: true as const } : {})
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
            initial: typeof row.initial === "string" ? row.initial : null,
            min: typeof row.min === "number" ? row.min : null,
            max: typeof row.max === "number" ? row.max : null,
            optional: row.optional === true
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
    const read = commandVariables(command, fill.custom);
    return replaceVariables(read.command, (use) => {
        const found = customUse(use.name, read.custom);
        if (found) {
            const { declared, axis } = found;
            const value = valueOf(declared, fill.values);
            if (value.length === 0) return declared.optional ? "" : null;
            if (declared.type === "coordinates") {
                const at = resolveCoordinates(value, player ? positionOf(player.values) : null);
                if (!at) return null;
                return axis === null ? at.join(" ") : at[axis]!;
            }
            return declared.type === "player" ? (playerSelector(value) ?? null) : value;
        }
        const spec = consoleSpec(use.name, fill.edition);
        if (!spec) return null;
        if (spec.name === "player") return player ? playerSelector(player.name) : null;
        const known = spec.kind === "server" ? fill.server[spec.name] : player?.values[spec.name];
        return commandSafe(known ?? use.fallback ?? "");
    });
}

/** Where a player stands, from the values read off them, or null. */
function positionOf(values: VariableValues): [number, number, number] | null {
    const axes = COORDINATE_AXES.map((axis) => Number(values[`player.${axis}`] ?? Number.NaN));
    return axes.every(Number.isFinite) ? [axes[0]!, axes[1]!, axes[2]!] : null;
}

/** What has to be read off each player before a run with a `~` position. */
export const POSITION_READS: readonly string[] = COORDINATE_AXES.map((axis) => `player.${axis}`);

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
    // A `~` is counted from each player's own spot; one whose spot could not be
    // read gets no line rather than one counted from nowhere.
    const relative = usesRelative(commandVariables(command, fill.custom).custom, fill.values);
    return players
        .filter((player) => playerSelector(player.name) !== null)
        .filter((player) => !relative || positionOf(player.values) !== null)
        .slice(0, MAX_PLAYER_LINES)
        .map((player) => fillCommand(command, fill, player));
}
