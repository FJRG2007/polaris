/**
 * How likely it is that a player is cheating, as a number out of 100 and a word
 * somebody can act on, with the reasons behind it.
 *
 * Built so the evidence decides and nothing else can: for X-Ray, only honeypots
 * dug to reach "Confirmed", at `CONFIRM_HITS` of them - the same rule the
 * notifications and the automatic ban follow. The game's own mining figures add
 * a little and never on their own lift a player past "Unlikely": somebody who
 * explores caves finds diamonds for very little rock, and on a real server that
 * was the owner. Movement tops out at "Likely", because it is seen a sample
 * every few seconds rather than move by move.
 *
 * Pure: the screen and the tests read the same answer.
 */

import { CONFIRM_HITS, type MiningFigures } from "./xray";

export type Likelihood = "unlikely" | "possible" | "likely" | "confirmed";

export interface Score {
    readonly value: number;
    readonly level: Likelihood;
    /** Why, one line per signal, strongest first. Empty for a clean player. */
    readonly reasons: readonly string[];
}

export const LIKELIHOOD_LABEL: Readonly<Record<Likelihood, string>> = {
    unlikely: "Unlikely",
    possible: "Possible",
    likely: "Likely",
    confirmed: "Confirmed"
};

export function levelOf(value: number): Likelihood {
    if (value >= 90) return "confirmed";
    if (value >= 60) return "likely";
    if (value >= 20) return "possible";
    return "unlikely";
}

/** The most the mining figures can ever add. Below the "Possible" line on purpose. */
export const MINING_WEIGHT_MAX = 15;

/** Too little mined to say anything about a rate. */
const MIN_ROCK = 200;
const MIN_ORE = 3;

/** Blocks of rock per ore, or null with too little to go on. */
export function rockPerOre(ore: number, rock: number): number | null {
    if (ore < MIN_ORE || rock < MIN_ROCK) return null;
    return rock / ore;
}

function rateWeight(perOre: number | null, fast: number, quick: number): number {
    if (perOre === null) return 0;
    if (perOre <= fast) return MINING_WEIGHT_MAX;
    if (perOre <= quick) return 8;
    return 0;
}

/** What one honeypot is worth: chance, most likely, but not nothing. */
const ONE_HIT = 45;

export function xrayScore(hits: number, mining: MiningFigures | null): Score {
    const reasons: string[] = [];
    if (hits >= CONFIRM_HITS) reasons.push(`Dug straight to ${hits} ores hidden in solid rock`);
    else if (hits === 1) reasons.push("Dug to 1 ore hidden in solid rock - one can be chance");

    const diamonds = mining ? rockPerOre(mining.diamonds, mining.deepRock) : null;
    const debris = mining ? rockPerOre(mining.debris, mining.netherRock) : null;
    const mined = Math.max(rateWeight(diamonds, 25, 50), rateWeight(debris, 40, 80));
    if (mined > 0) {
        const which =
            rateWeight(diamonds, 25, 50) >= rateWeight(debris, 40, 80)
                ? `1 diamond per ${Math.round(diamonds!)} deepslate`
                : `1 ancient debris per ${Math.round(debris!)} nether rock`;
        reasons.push(`Mines ${which} - fast, though exploring caves does that too`);
    }

    const value =
        hits >= CONFIRM_HITS
            ? Math.min(100, 90 + (hits - CONFIRM_HITS) * 3)
            : hits === 1
              ? Math.min(89, ONE_HIT + mined)
              : Math.min(19, mined);
    return { value, level: levelOf(value), reasons };
}

/** Movement never reaches "Confirmed": see the top of this file. */
export const MOVEMENT_MAX = 85;

export function movementScore(flights: number, teleports: number): Score {
    const reasons: string[] = [];
    if (flights > 0)
        reasons.push(
            `Hovered in the air ${flights === 1 ? "once" : `${flights} times`} without being allowed to fly`
        );
    if (teleports > 0)
        reasons.push(
            `Moved further than anybody can ${teleports === 1 ? "once" : `${teleports} times`}, with no command explaining it`
        );
    const fly = flights === 0 ? 0 : flights === 1 ? 40 : flights === 2 ? 65 : 80;
    const jump = teleports === 0 ? 0 : teleports === 1 ? 25 : teleports === 2 ? 40 : 55;
    const value = Math.min(MOVEMENT_MAX, Math.max(fly, jump) + Math.round(Math.min(fly, jump) / 3));
    return { value, level: levelOf(value), reasons };
}

/** One player as the screen lists them: both scores and what they rest on. */
export interface Suspect {
    readonly key: string;
    readonly name: string;
    readonly xray: Score;
    readonly movement: Score;
    readonly hits: number;
    readonly flights: number;
    readonly teleports: number;
    readonly mining: MiningFigures | null;
    /** The latest incident of any kind, or null for a player with only figures. */
    readonly lastAt: number | null;
    readonly warnedAt: number | null;
    readonly bannedAt: number | null;
}

/** An incident of any kind, for the list of where and when. */
export interface SuspectIncident {
    readonly name: string;
    readonly kind: "honeypot" | "flying" | "teleport";
    readonly dimension: string;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    /** How far a teleport went; null for the others. */
    readonly distance: number | null;
    readonly at: number;
}

interface PointAt {
    readonly dimension: string;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly at: number;
}

/**
 * Every player worth a row - anybody with evidence of either kind, and anybody
 * the game has mining figures for - scored, the most suspicious first.
 */
export function buildSuspects(input: {
    readonly honeypots: readonly {
        readonly name: string;
        readonly hits: readonly PointAt[];
        readonly warnedAt: number | null;
        readonly bannedAt: number | null;
    }[];
    readonly movement: readonly {
        readonly name: string;
        readonly incidents: readonly (PointAt & { kind: "flying" | "teleport"; distance: number | null })[];
    }[];
    readonly mining: readonly { readonly name: string; readonly figures: MiningFigures }[];
}): { suspects: Suspect[]; incidents: SuspectIncident[] } {
    const rows = new Map<string, { name: string; hits: PointAt[]; moves: SuspectIncident[]; mining: MiningFigures | null; warnedAt: number | null; bannedAt: number | null }>();
    const row = (name: string) => {
        const key = name.toLowerCase();
        const held = rows.get(key) ?? { name, hits: [], moves: [], mining: null, warnedAt: null, bannedAt: null };
        rows.set(key, held);
        return held;
    };
    for (const one of input.honeypots) {
        const held = row(one.name);
        held.hits.push(...one.hits);
        held.warnedAt = one.warnedAt;
        held.bannedAt = one.bannedAt;
    }
    for (const one of input.movement) {
        row(one.name).moves.push(
            ...one.incidents.map((incident) => ({
                name: one.name,
                kind: incident.kind,
                dimension: incident.dimension,
                x: incident.x,
                y: incident.y,
                z: incident.z,
                distance: incident.distance,
                at: incident.at
            }))
        );
    }
    for (const one of input.mining) {
        if (one.figures.deepRock + one.figures.netherRock > 0) row(one.name).mining = one.figures;
    }

    const suspects: Suspect[] = [];
    const incidents: SuspectIncident[] = [];
    for (const [key, held] of rows) {
        const flights = held.moves.filter((one) => one.kind === "flying").length;
        const teleports = held.moves.length - flights;
        const times = [...held.hits.map((one) => one.at), ...held.moves.map((one) => one.at)];
        suspects.push({
            key,
            name: held.name,
            xray: xrayScore(held.hits.length, held.mining),
            movement: movementScore(flights, teleports),
            hits: held.hits.length,
            flights,
            teleports,
            mining: held.mining,
            lastAt: times.length > 0 ? Math.max(...times) : null,
            warnedAt: held.warnedAt,
            bannedAt: held.bannedAt
        });
        incidents.push(
            ...held.hits.map((hit) => ({
                name: held.name,
                kind: "honeypot" as const,
                dimension: hit.dimension,
                x: hit.x,
                y: hit.y,
                z: hit.z,
                distance: null,
                at: hit.at
            })),
            ...held.moves
        );
    }
    suspects.sort(
        (left, right) =>
            Math.max(right.xray.value, right.movement.value) - Math.max(left.xray.value, left.movement.value) ||
            left.name.localeCompare(right.name)
    );
    incidents.sort((left, right) => right.at - left.at);
    return { suspects, incidents };
}
