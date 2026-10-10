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
 * every few seconds rather than move by move. Polaris's anti-cheat engine sees
 * every packet and compensates for latency, and it only reports a check once it
 * has failed past its own alert threshold, so it is the one signal besides the
 * honeypots that can reach "Confirmed" - on repeated alerts, never on one. On a
 * modded server its movement and block checks are the exception: they model
 * blocks and items the server's mods replace, so on their own they stop at
 * "Possible" (`approximateOnMods`).
 *
 * Pure: the screen and the tests read the same answer.
 */

import type { Translator } from "@polaris/core";
import { gameCatalogs, type GameKey } from "../../../messages";
import { CONFIRM_HITS, type MiningFigures } from "./xray";

export type Likelihood = "unlikely" | "possible" | "likely" | "confirmed";

export interface Score {
    readonly value: number;
    readonly level: Likelihood;
    /** Why, one line per signal, strongest first. Empty for a clean player. */
    readonly reasons: readonly string[];
    /** The same reasons as data, in the same order, for a screen to put in its
     *  reader's language; `reasons` is their English, for logs and alerts. */
    readonly why: readonly ScoreReason[];
}

/** One signal behind a score. */
export type ScoreReason =
    | { readonly kind: "hits"; readonly count: number }
    | { readonly kind: "oneHit" }
    | { readonly kind: "rate"; readonly ore: "diamond" | "debris"; readonly per: number }
    | { readonly kind: "flights"; readonly count: number }
    | { readonly kind: "teleports"; readonly count: number }
    | { readonly kind: "engine"; readonly check: string; readonly alerts: number }
    | { readonly kind: "modded" };

/** The words a score's reasons are written in. */
export type SuspicionText = Translator<GameKey<"minecraft">>;

const ENGLISH: SuspicionText = gameCatalogs.translator("en-US", "minecraft");

/** A reason in the reader's language; English when no reader is given, for
 *  logs and the tests. */
export function reasonLine(reason: ScoreReason, t: SuspicionText = ENGLISH): string {
    switch (reason.kind) {
        case "hits":
            return t("xray.reasons.hits", { count: reason.count });
        case "oneHit":
            return t("xray.reasons.oneHit");
        case "rate":
            return t(
                reason.ore === "diamond" ? "xray.reasons.rateDiamond" : "xray.reasons.rateDebris",
                {
                    per: reason.per
                }
            );
        case "flights":
            return t("xray.reasons.flights", { count: reason.count });
        case "teleports":
            return t("xray.reasons.teleports", { count: reason.count });
        case "engine": {
            const label = engineCheckLabel(reason.check, t);
            return t("xray.reasons.engine", {
                label: `${label[0]!.toUpperCase()}${label.slice(1)}`,
                check: reason.check,
                count: reason.alerts
            });
        }
        case "modded":
            return t("xray.reasons.modded");
    }
}

function scored(value: number, why: readonly ScoreReason[]): Score {
    return { value, level: levelOf(value), reasons: why.map((reason) => reasonLine(reason)), why };
}

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
    const why: ScoreReason[] = [];
    if (hits >= CONFIRM_HITS) why.push({ kind: "hits", count: hits });
    else if (hits === 1) why.push({ kind: "oneHit" });

    const diamonds = mining ? rockPerOre(mining.diamonds, mining.deepRock) : null;
    const debris = mining ? rockPerOre(mining.debris, mining.netherRock) : null;
    const mined = Math.max(rateWeight(diamonds, 25, 50), rateWeight(debris, 40, 80));
    if (mined > 0) {
        why.push(
            rateWeight(diamonds, 25, 50) >= rateWeight(debris, 40, 80)
                ? { kind: "rate", ore: "diamond", per: Math.round(diamonds!) }
                : { kind: "rate", ore: "debris", per: Math.round(debris!) }
        );
    }

    const value =
        hits >= CONFIRM_HITS
            ? Math.min(100, 90 + (hits - CONFIRM_HITS) * 3)
            : hits === 1
              ? Math.min(89, ONE_HIT + mined)
              : Math.min(19, mined);
    return scored(value, why);
}

/** Movement never reaches "Confirmed": see the top of this file. */
export const MOVEMENT_MAX = 85;

export function movementScore(flights: number, teleports: number): Score {
    const why: ScoreReason[] = [];
    if (flights > 0) why.push({ kind: "flights", count: flights });
    if (teleports > 0) why.push({ kind: "teleports", count: teleports });
    const fly = flights === 0 ? 0 : flights === 1 ? 40 : flights === 2 ? 65 : 80;
    const jump = teleports === 0 ? 0 : teleports === 1 ? 25 : teleports === 2 ? 40 : 55;
    const value = Math.min(MOVEMENT_MAX, Math.max(fly, jump) + Math.round(Math.min(fly, jump) / 3));
    return scored(value, why);
}

/** The parts of the engine's check names there are words for, under
 *  `xray.checks` in the catalogs (the engine names variants with a letter,
 *  "BadPacketsA", and kinds with a word in front, "FarPlace"). Tried in order,
 *  so the more specific come first. */
const ENGINE_CHECKS = [
    "XRayProbe",
    "Simulation",
    "Reach",
    "Hitboxes",
    "Aim",
    "Autoclicker",
    "Killaura",
    "GroundSpoof",
    "NoFall",
    "Timer",
    "NoSlow",
    "Sprint",
    "AntiKB",
    "Knockback",
    "Explosion",
    "Elytra",
    "Vehicle",
    "Phase",
    "Baritone",
    "MultiActions",
    "FarPlace",
    "Place",
    "FastBreak",
    "FarBreak",
    "Break",
    "Interact",
    "BadPackets",
    "PacketOrder",
    "TransactionOrder",
    "Post",
    "Crash",
    "Exploit",
    "Chat"
] as const;

/** A named part of the engine's checks, which a catalog keys its words by. */
export type EngineCheckPart = (typeof ENGINE_CHECKS)[number];

/** Which listed part a check's name falls under, or null for one not listed. */
export function engineCheckPart(check: string): EngineCheckPart | null {
    return ENGINE_CHECKS.find((part) => check.includes(part)) ?? null;
}

/** A check's name in words, or the name itself for one not listed. */
export function engineCheckLabel(check: string, t: SuspicionText = ENGLISH): string {
    const part = engineCheckPart(check);
    return part ? t(`xray.checks.${part}`) : check;
}

/** The score an alert count reaches: one could be a glitch the engine did not
 *  model, a handful is a pattern, ten is "Confirmed". */
function alertsWeight(alerts: number): number {
    if (alerts <= 0) return 0;
    if (alerts === 1) return 35;
    if (alerts === 2) return 50;
    if (alerts <= 4) return 65;
    if (alerts <= 9) return 80;
    return 92;
}

/**
 * The checks that predict a player from the blocks and items around them and
 * from the server keeping time: how they move through and on them, and how long
 * a block takes to break or where one may go. On a modded server the engine only
 * knows the mods' blocks and items through vanilla stand-ins - a server with a
 * few mods has thousands of block states it does not model - and a heavy modpack
 * runs below twenty ticks a second, so these fail for honest players there, and
 * did on a real one: "Confirmed" on Simulation for somebody walking over modded
 * blocks, FastBreak on cobblestone mined with a modded pick.
 */
const APPROXIMATE_ON_MODS: ReadonlySet<EngineCheckPart> = new Set<EngineCheckPart>([
    "Simulation",
    "GroundSpoof",
    "NoFall",
    "Timer",
    "NoSlow",
    "Sprint",
    "AntiKB",
    "Knockback",
    "Explosion",
    "Elytra",
    "Vehicle",
    "Phase",
    "FarPlace",
    "Place",
    "FastBreak",
    "FarBreak",
    "Break"
]);

/** Block checks that read only the packets, not the block: as exact with mods. */
const PACKET_ONLY: ReadonlySet<string> = new Set([
    "MultiBreak",
    "NoSwingBreak",
    "MultiPlace",
    "DuplicateRotPlace"
]);

/** Whether a check is only approximate on a modded server. */
export function approximateOnMods(check: string): boolean {
    const part = engineCheckPart(check);
    return part !== null && APPROXIMATE_ON_MODS.has(part) && !PACKET_ONLY.has(check);
}

/** The most those checks reach on their own on a modded server: "Possible". */
export const MODDED_APPROXIMATE_MAX = 55;

function alertsValue(
    checks: readonly { readonly check: string; readonly alerts: number }[]
): number {
    const alerts = checks.reduce((sum, one) => sum + one.alerts, 0);
    if (alerts === 0) return 0;
    // Different checks failing is stronger than one check failing more: a
    // glitch the engine does not model trips the same check again.
    const distinct = new Set(checks.map((one) => one.check)).size;
    return Math.min(98, alertsWeight(alerts) + Math.min(6, (distinct - 1) * 2));
}

/**
 * The engine's score. On a modded server (`modded`) the checks in
 * `APPROXIMATE_ON_MODS` are scored apart and held to `MODDED_APPROXIMATE_MAX`,
 * so only the others - aim, reach, packets, the X-Ray probe - can make a player
 * "Likely" or "Confirmed" there. Worked out whenever it is read, so flags kept
 * from before count the same way.
 */
export function engineScore(
    checks: readonly { readonly check: string; readonly alerts: number }[],
    modded = false
): Score {
    const failing = checks.filter((one) => one.alerts > 0);
    if (failing.length === 0) return scored(0, []);
    const approximate = modded ? failing.filter((one) => approximateOnMods(one.check)) : [];
    const exact = modded ? failing.filter((one) => !approximateOnMods(one.check)) : failing;
    const exactValue = alertsValue(exact);
    const approximateValue = Math.min(MODDED_APPROXIMATE_MAX, alertsValue(approximate));
    const value = Math.max(exactValue, approximateValue);
    const byAlerts = (left: { alerts: number }, right: { alerts: number }) =>
        right.alerts - left.alerts;
    const [leading, trailing] =
        exactValue >= approximateValue ? [exact, approximate] : [approximate, exact];
    const why = [...[...leading].sort(byAlerts), ...[...trailing].sort(byAlerts)]
        .slice(0, 3)
        .map((one): ScoreReason => ({ kind: "engine", check: one.check, alerts: one.alerts }));
    if (approximate.length > 0) why.push({ kind: "modded" });
    return scored(value, why);
}

/** One player as the screen lists them: every score and what they rest on. */
export interface Suspect {
    readonly key: string;
    readonly name: string;
    readonly xray: Score;
    readonly movement: Score;
    /** What Polaris's anti-cheat engine caught. */
    readonly engine: Score;
    /** The engine's checks that failed, most first. */
    readonly engineChecks: readonly { readonly check: string; readonly alerts: number }[];
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
        readonly incidents: readonly (PointAt & {
            kind: "flying" | "teleport";
            distance: number | null;
        })[];
    }[];
    readonly mining: readonly { readonly name: string; readonly figures: MiningFigures }[];
    /** What Polaris's anti-cheat engine caught, per player. */
    readonly engine?: readonly {
        readonly name: string;
        readonly checks: readonly {
            readonly check: string;
            readonly alerts: number;
            readonly lastAt: number;
        }[];
    }[];
    /**
     * Everybody else to list, at nothing found: whoever is online now. A table
     * of only the players something was found against left out the one somebody
     * was looking at - a player mining right now whose counts the game had not
     * written to disk yet - and reading as "not here" is not the same as "clean".
     */
    readonly players?: readonly string[];
    /** Whether the server runs mods, which the engine's movement and block
     *  checks only approximate (`engineScore`). */
    readonly modded?: boolean;
}): { suspects: Suspect[]; incidents: SuspectIncident[] } {
    const rows = new Map<
        string,
        {
            name: string;
            hits: PointAt[];
            moves: SuspectIncident[];
            mining: MiningFigures | null;
            engine: { check: string; alerts: number; lastAt: number }[];
            warnedAt: number | null;
            bannedAt: number | null;
        }
    >();
    const row = (name: string) => {
        const key = name.toLowerCase();
        const held = rows.get(key) ?? {
            name,
            hits: [],
            moves: [],
            mining: null,
            engine: [],
            warnedAt: null,
            bannedAt: null
        };
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
        // Listed whatever they mined; the rate only once there is rock to rate.
        const held = row(one.name);
        if (one.figures.deepRock + one.figures.netherRock > 0) held.mining = one.figures;
    }
    for (const one of input.engine ?? []) row(one.name).engine.push(...one.checks);
    for (const name of input.players ?? []) row(name);

    const suspects: Suspect[] = [];
    const incidents: SuspectIncident[] = [];
    for (const [key, held] of rows) {
        const flights = held.moves.filter((one) => one.kind === "flying").length;
        const teleports = held.moves.length - flights;
        const times = [
            ...held.hits.map((one) => one.at),
            ...held.moves.map((one) => one.at),
            ...held.engine.map((one) => one.lastAt)
        ];
        const engineChecks = [...held.engine]
            .sort((left, right) => right.alerts - left.alerts)
            .map(({ check, alerts }) => ({ check, alerts }));
        suspects.push({
            key,
            name: held.name,
            xray: xrayScore(held.hits.length, held.mining),
            movement: movementScore(flights, teleports),
            engine: engineScore(engineChecks, input.modded ?? false),
            engineChecks,
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
    const worst = (one: Suspect) => Math.max(one.xray.value, one.movement.value, one.engine.value);
    suspects.sort(
        (left, right) => worst(right) - worst(left) || left.name.localeCompare(right.name)
    );
    incidents.sort((left, right) => right.at - left.at);
    return { suspects, incidents };
}
