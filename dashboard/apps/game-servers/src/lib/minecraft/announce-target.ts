/**
 * Who an announcement goes to: everybody, the operators who are online, or the
 * players somebody picked - one or several.
 *
 * Still one string on the announcement, so a template or a held announcement
 * saved before there was a choice reads exactly as it did: `@a` is everybody
 * and a bare name is that player. Two forms are new: `@ops`, and names joined
 * with commas. Nothing here is ever put into a command as typed - every form is
 * matched against what it may be, and a name is a name or it is refused.
 */

/** Everybody on the server, as the game's own selector says it. */
export const EVERYBODY = "@a";

/** The operators who are online when it goes. Polaris's word, not the game's:
 *  the game has no selector for them, so it becomes their names at send time. */
export const OPERATORS = "@ops";

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
    | { readonly kind: "players"; readonly players: readonly string[] };

/** What a stored target means, or null for one that is not a target at all. */
export function parseTarget(target: string): Audience | null {
    if (target === EVERYBODY) return { kind: "everybody" };
    if (target === OPERATORS) return { kind: "operators" };
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
    const [first, second, ...rest] = audience.players;
    if (second === undefined) return first ?? "";
    if (rest.length === 0) return `${first} and ${second}`;
    return `${first}, ${second} and ${rest.length} more`;
}

/**
 * What the commands are aimed at: the selector for everybody, or one name per
 * player. Operators become the names of the ones online, which the caller
 * reads from the server; none online is none to send to.
 */
export function concreteTargets(audience: Audience, operatorsOnline: readonly string[] = []): string[] {
    if (audience.kind === "everybody") return [EVERYBODY];
    const names = audience.kind === "operators" ? operatorsOnline : audience.players;
    return names.filter(isPickableName);
}
