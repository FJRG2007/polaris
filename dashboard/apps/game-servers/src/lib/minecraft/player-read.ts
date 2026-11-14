/**
 * What Polaris asks the game about one player, for a kept console command:
 * where they stand, which dimension they are in, their level and their health -
 * and where the last player to die did.
 *
 * A text on screen draws these itself (a score the game keeps for `@s`), but a
 * command is a line Polaris writes before it goes, so the values have to be in
 * it already. Each is read with `data get entity`, which answers
 * `Steve has the following entity data: <value>` with the value in the game's
 * own notation: `[12.5d, 64.0d, -30.2d]`, `"minecraft:overworld"`, `20.0f`.
 *
 * Java only: Bedrock has no `data` command. A player who is not online has no
 * entity to read, and reads as nothing, so the command takes its fallback.
 *
 * The parsers are pure; the read is one batch of questions per press.
 */

import { stripFormatting } from "./parse";
import type { ServerContainer } from "./service";
import { DEATH_PLACE_VARIABLES, PLAYER_READS, type VariableValues } from "./text-vars";

/** A name the game can be asked about: Java names hold nothing else. */
const NAME = /^[A-Za-z0-9_]{1,16}$/;
const DATA = /has the following entity data:\s*/i;
const NUMBER = "(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)";
const POSITION = new RegExp(
    `^\\[\\s*${NUMBER}[dD]?\\s*,\\s*${NUMBER}[dD]?\\s*,\\s*${NUMBER}[dD]?\\s*\\]$`
);
const SCALAR = new RegExp(`^${NUMBER}[bsilfdBSILFD]?$`);
const QUOTED = /^"([^"\\]*)"$|^'([^'\\]*)'$/;
const DEATH_DIMENSION = /dimension:\s*"([^"\\]+)"/;
const DEATH_POS = /pos:\s*\[\s*I\s*;\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/;
/** A dimension id as the game writes one: `minecraft:the_nether`. */
const DIMENSION = /^[a-z0-9_.-]{1,64}:[a-z0-9_./-]{1,64}$/;

/** The value part of a `data get entity` answer, or null for any other answer
 *  ("No entity was found", an error). */
export function entityData(output: string): string | null {
    const text = stripFormatting(output).replace(/\u001b/g, "");
    const match = DATA.exec(text);
    if (!match) return null;
    const value = text.slice(match.index + match[0].length).trim();
    return value.length > 0 ? value : null;
}

/** The block a position is in: the game's own rounding, down. */
function block(value: string): number | null {
    const number = Number(value);
    return Number.isFinite(number) ? Math.floor(number) : null;
}

/** `[12.5d, 64.0d, -30.2d]` as the block coordinates it stands in. */
export function readPosition(data: string): [number, number, number] | null {
    const match = POSITION.exec(data.trim());
    if (!match) return null;
    const axes = [block(match[1] as string), block(match[2] as string), block(match[3] as string)];
    return axes.every((axis) => axis !== null) ? (axes as [number, number, number]) : null;
}

/** `20.0f`, `12` as a whole number, down, as a score would show it. */
export function readWhole(data: string): number | null {
    const match = SCALAR.exec(data.trim());
    return match ? block(match[1] as string) : null;
}

/** `"minecraft:overworld"` as the id, or null for anything that is not one. */
export function readDimension(data: string): string | null {
    const match = QUOTED.exec(data.trim());
    const id = match ? (match[1] ?? match[2] ?? "") : "";
    return DIMENSION.test(id) ? id : null;
}

/** Where somebody last died, from `{dimension: "...", pos: [I; x, y, z]}`. */
export function readDeathPlace(
    data: string
): { dimension: string; x: number; y: number; z: number } | null {
    const dimension = DEATH_DIMENSION.exec(data)?.[1] ?? "";
    const pos = DEATH_POS.exec(data);
    if (!pos || !DIMENSION.test(dimension)) return null;
    return { dimension, x: Number(pos[1]), y: Number(pos[2]), z: Number(pos[3]) };
}

/** The values one player's answers give, by variable; a field that did not
 *  answer is left out, so the command takes its fallback. */
export function playerValues(
    answers: ReadonlyMap<string, string | null>,
    wanted: readonly string[]
): VariableValues {
    const values: Record<string, string | null> = {};
    const pos = answers.get("Pos");
    const position = pos ? readPosition(pos) : null;
    for (const name of wanted) {
        const field = PLAYER_READS[name];
        if (!field) continue;
        const data = answers.get(field) ?? null;
        if (field === "Pos") {
            const axis = ["player.x", "player.y", "player.z"].indexOf(name);
            values[name] = position ? String(position[axis]) : null;
        } else if (field === "Dimension") {
            values[name] = data ? readDimension(data) : null;
        } else {
            const whole = data ? readWhole(data) : null;
            values[name] = whole === null ? null : String(whole);
        }
    }
    return values;
}

/** The fields to ask for, once each, for the variables a command uses. */
export function fieldsFor(wanted: readonly string[]): string[] {
    return [...new Set(wanted.flatMap((name) => (PLAYER_READS[name] ? [PLAYER_READS[name]] : [])))];
}

type Asker = Pick<ServerContainer, "say" | "sayEach">;

/** Every question at once where the server can take them together, and each
 *  answer that did not arrive whole asked again on its own. */
async function ask(server: Asker, commands: readonly (readonly string[])[]): Promise<string[]> {
    const batch = server.sayEach
        ? await server.sayEach(commands).catch(() => commands.map(() => null))
        : commands.map(() => null);
    return Promise.all(
        commands.map(async (command, index) => {
            const answer = batch[index];
            if (typeof answer === "string") return answer;
            return server.say(command).catch(() => "");
        })
    );
}

/**
 * The per-player values each named player's line needs, by lowercased name.
 * Names the game would not take are skipped and read as nothing.
 */
export async function readPlayerValues(
    server: Asker,
    names: readonly string[],
    wanted: readonly string[]
): Promise<Map<string, VariableValues>> {
    const fields = fieldsFor(wanted);
    const players = [...new Set(names.filter((name) => NAME.test(name)))];
    const found = new Map<string, VariableValues>();
    if (fields.length === 0 || players.length === 0) return found;
    const commands = players.flatMap((name) =>
        fields.map((field) => ["data", "get", "entity", name, field] as const)
    );
    const answers = await ask(server, commands);
    players.forEach((name, row) => {
        const byField = new Map<string, string | null>(
            fields.map((field, column) => [
                field,
                entityData(answers[row * fields.length + column] ?? "")
            ])
        );
        found.set(name.toLowerCase(), playerValues(byField, wanted));
    });
    return found;
}

/** Where `player` last died, as the death variables, or all of them null when
 *  they are offline, never died, or the server is older than the field. */
export async function readDeathValues(
    server: Asker,
    player: string | null
): Promise<VariableValues> {
    const none = Object.fromEntries(DEATH_PLACE_VARIABLES.map((name) => [name, null]));
    if (!player || !NAME.test(player)) return none;
    const [answer] = await ask(server, [["data", "get", "entity", player, "LastDeathLocation"]]);
    const data = entityData(answer ?? "");
    const place = data ? readDeathPlace(data) : null;
    if (!place) return none;
    return {
        "death.x": String(place.x),
        "death.y": String(place.y),
        "death.z": String(place.z),
        "death.dimension": place.dimension
    };
}
