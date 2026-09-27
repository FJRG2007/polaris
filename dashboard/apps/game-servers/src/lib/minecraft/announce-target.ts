/**
 * Who an announcement goes to: everybody, the operators who are online,
 * everybody but them, the players in one game mode, or the players somebody
 * picked - one or several.
 *
 * Still one string on the announcement, so a template or a held announcement
 * saved before there was a choice reads exactly as it did: `@a` is everybody
 * and a bare name is that player. The other forms are `@ops`, `@others`,
 * `@a[gamemode=<mode>]` and names joined with commas. Nothing here is ever put
 * into a command as typed - every form is matched against what it may be, and a
 * name is a name or it is refused.
 */

/** Everybody on the server, as the game's own selector says it. */
export const EVERYBODY = "@a";

/** The operators who are online when it goes. Polaris's word, not the game's:
 *  the game has no selector for them, so it becomes their names at send time. */
export const OPERATORS = "@ops";

/** Everybody on the server who is not an operator. Polaris's word too, and
 *  names at send time for the same reason. */
export const NON_OPERATORS = "@others";

/** The game modes an announcement can be aimed at, in the game's own words. */
export const GAME_MODES = ["survival", "creative", "adventure", "spectator"] as const;

export type GameMode = (typeof GAME_MODES)[number];

/** The players in one game mode, as it is stored. */
export function gameModeTarget(mode: GameMode): string {
    return `@a[gamemode=${mode}]`;
}

/** The most players one announcement is picked out for by name. */
export const MOST_PICKED = 50;

const JAVA_NAME = /^[A-Za-z0-9_]{1,16}$/;

/** As long as any name a command can be aimed at, for measuring one before the
 *  names are known. */
export const LONGEST_NAME = "_".repeat(16);

/** Whether a name can be picked out: the only names ever written into a command. */
export function isPickableName(name: string): boolean {
    return JAVA_NAME.test(name);
}

export type Audience =
    | { readonly kind: "everybody" }
    | { readonly kind: "operators" }
    | { readonly kind: "others" }
    | { readonly kind: "gamemode"; readonly mode: GameMode }
    | { readonly kind: "players"; readonly players: readonly string[] };

/** What a stored target means, or null for one that is not a target at all. */
export function parseTarget(target: string): Audience | null {
    if (target === EVERYBODY) return { kind: "everybody" };
    if (target === OPERATORS) return { kind: "operators" };
    if (target === NON_OPERATORS) return { kind: "others" };
    const mode = GAME_MODES.find((one) => gameModeTarget(one) === target);
    if (mode) return { kind: "gamemode", mode };
    const players = target.split(",");
    if (players.length === 0 || players.length > MOST_PICKED) return null;
    if (!players.every(isPickableName)) return null;
    const unique = new Set(players.map((name) => name.toLowerCase()));
    if (unique.size !== players.length) return null;
    return { kind: "players", players };
}

/** The target for players picked by name, in the order they were picked. */
export function playersTarget(players: readonly string[]): string {
    return players.join(",");
}

/** Who it goes to, in words for "Sent to ...". */
export function describeTarget(target: string): string {
    const audience = parseTarget(target);
    if (!audience || audience.kind === "everybody") return "everybody on the server";
    if (audience.kind === "operators") return "the operators who are on";
    if (audience.kind === "others") return "everybody on the server but the operators";
    if (audience.kind === "gamemode") return `the players in ${GAME_MODE_LABEL[audience.mode]}`;
    const [first, second, ...rest] = audience.players;
    if (second === undefined) return first ?? "";
    if (rest.length === 0) return `${first} and ${second}`;
    return `${first}, ${second} and ${rest.length} more`;
}

/** A game mode as the game's menus say it. */
export const GAME_MODE_LABEL: Readonly<Record<GameMode, string>> = {
    survival: "Survival",
    creative: "Creative",
    adventure: "Adventure",
    spectator: "Spectator"
};

/** Whether the audience is one Polaris turns into names itself, from who is on
 *  and who the operators are, because the game has no selector for it. Java
 *  only: Bedrock keeps its operators by xuid. */
export function namedByPolaris(audience: Audience): boolean {
    return audience.kind === "operators" || audience.kind === "others";
}

/** Who is on the server now, and which of them are operators. */
export interface Roster {
    readonly players: readonly string[];
    readonly operators: readonly string[];
}

/** The names an audience Polaris names itself is, out of who is on now. */
export function audienceNames(audience: Audience, roster: Roster): string[] {
    const operators = new Set(roster.operators.map((name) => name.toLowerCase()));
    if (audience.kind === "operators") {
        return roster.players.filter((name) => operators.has(name.toLowerCase()));
    }
    if (audience.kind === "others") {
        return roster.players.filter((name) => !operators.has(name.toLowerCase()));
    }
    return [];
}

/**
 * What the commands are aimed at: a selector for everybody or a game mode, or
 * one name per player. Operators, and everybody but them, become the names
 * `named` the caller worked out from the server (`audienceNames`); none on is
 * none to send to.
 */
export function concreteTargets(
    audience: Audience,
    named: readonly string[] = [],
    edition: "java" | "bedrock" = "java"
): string[] {
    if (audience.kind === "everybody") return [EVERYBODY];
    if (audience.kind === "gamemode") {
        return [edition === "bedrock" ? `@a[m=${audience.mode}]` : gameModeTarget(audience.mode)];
    }
    const names = namedByPolaris(audience) ? named : audience.players;
    return names.filter(isPickableName);
}
