/**
 * Catching X-Ray without accusing anybody who is not using it.
 *
 * The game's own statistics cannot do it on their own. A player who explores
 * the caves of a 1.18+ world picks up diamonds the stone around them never hid,
 * and on a real server that made the owner look like the worst offender. So the
 * statistics are shown for context and never counted as proof.
 *
 * The proof is a honeypot: a single diamond ore (or ancient debris in the
 * Nether) that Polaris places fully enclosed in natural rock, away from anybody,
 * where no legitimate player can see it. The game's live counter says who mined
 * a diamond in the last few seconds; if one of Polaris's honeypots is gone from
 * right beside them at that moment, they dug through solid rock straight to a
 * block they had no way of knowing was there.
 *
 * What keeps it from ever pointing at the wrong person:
 *
 * - A hit needs all three at once: the ore gone, the player's mined counter up
 *   since the last look, and the player within `HIT_RANGE` of it. An explosion
 *   takes a honeypot without anybody's counter moving, and is not a hit.
 * - One hit is chance - a branch mine can run into one. Nothing is said about a
 *   player until `CONFIRM_HITS` different honeypots, and nothing is done to them
 *   automatically before `BAN_HITS` at the earliest.
 * - Every hit is kept with where and when, so the person deciding sees the
 *   evidence and can clear a player with one press.
 *
 * Pure: every command and every decision can be asserted without a server.
 */

import { z } from "zod";
import { stripFormatting } from "./parse";

/** Where the settings and the traps are kept on the install. */
export const XRAY_KEY = "xrayTraps";

export type Dimension = "minecraft:overworld" | "minecraft:the_nether";

/** What each dimension hides, in what, and at which heights. */
export const TRAP_KINDS: Readonly<
    Record<
        Dimension,
        {
            readonly ore: string;
            /** The block the ore replaces: natural rock at that depth. */
            readonly rock: string;
            /** What every neighbour must be, so the ore touches no air at all. */
            readonly neighbours: string;
            readonly minY: number;
            readonly maxY: number;
            /** The live counter that moves when a player mines this ore. */
            readonly objective: string;
        }
    >
> = {
    "minecraft:overworld": {
        ore: "minecraft:deepslate_diamond_ore",
        rock: "minecraft:deepslate",
        neighbours: "#minecraft:deepslate_ore_replaceables",
        minY: -58,
        maxY: -20,
        objective: "polaris_xray_d"
    },
    "minecraft:the_nether": {
        ore: "minecraft:ancient_debris",
        rock: "minecraft:netherrack",
        neighbours: "#minecraft:base_stone_nether",
        minY: 8,
        maxY: 22,
        objective: "polaris_xray_n"
    }
};

export const DIMENSIONS = Object.keys(TRAP_KINDS) as Dimension[];

/** How close to a vanished honeypot a player who just mined that ore has to be.
 *  A pickaxe reaches under five blocks; the rest is how far they can walk in the
 *  seconds between two looks. */
export const HIT_RANGE = 7;

/** Honeypots from which a player is reported, and the fewest before anything
 *  can be done to them automatically. */
export const CONFIRM_HITS = 2;
export const BAN_HITS_MIN = 3;

/** How long evidence counts. Two lucky finds a month apart are not a pattern. */
export const EVIDENCE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Where honeypots go around a player: out of sight, inside what they could reach. */
export const PLACE_MIN_DISTANCE = 20;
export const PLACE_MAX_DISTANCE = 56;

export type XrayAction = "notify" | "warn" | "warn-and-ban";

export const DEFAULT_WARNING =
    "&8[&cAnti X-Ray&8] &7We have detected possible &cX-Ray &7use. This is your &efirst warning&7. If it happens again you will be &ctemporarily banned&7.";

export const xraySettingsSchema = z.object({
    enabled: z.boolean(),
    /** Honeypots kept around the players in each dimension. */
    perDimension: z.number().int().min(4).max(40),
    action: z.enum(["notify", "warn", "warn-and-ban"]),
    /** Honeypots before the automatic ban; never fewer than `BAN_HITS_MIN`. */
    banHits: z.number().int().min(BAN_HITS_MIN).max(10),
    banHours: z
        .number()
        .int()
        .min(1)
        .max(7 * 24),
    warning: z
        .string()
        .max(400)
        .refine((value) => !/[\0\r\n]/.test(value), "One line"),
    /** Whether the Nether gets honeypots too. */
    nether: z.boolean()
});

export type XraySettings = z.infer<typeof xraySettingsSchema>;

export const DEFAULT_XRAY_SETTINGS: XraySettings = {
    enabled: false,
    perDimension: 12,
    action: "notify",
    banHits: 3,
    banHours: 24,
    warning: DEFAULT_WARNING,
    nether: true
};

export interface Honeypot {
    readonly dimension: Dimension;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly placedAt: number;
}

export interface Hit {
    readonly dimension: Dimension;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly at: number;
}

export interface PlayerEvidence {
    /** The name as the game spells it. */
    readonly name: string;
    readonly hits: readonly Hit[];
    /** When Polaris last told somebody about this player, so it says it once per level. */
    readonly reportedHits: number;
    readonly warnedAt: number | null;
    readonly bannedAt: number | null;
}

export interface XrayState {
    readonly settings: XraySettings;
    readonly honeypots: readonly Honeypot[];
    /** By lowercased name. */
    readonly evidence: Readonly<Record<string, PlayerEvidence>>;
    /** Honeypots switched off whose ore could not be put back yet (their chunk
     *  was not loaded), retried until it can. */
    readonly cleanup: readonly Honeypot[];
}

export const EMPTY_XRAY: XrayState = {
    settings: DEFAULT_XRAY_SETTINGS,
    honeypots: [],
    evidence: {},
    cleanup: []
};

const dimension = z.enum(["minecraft:overworld", "minecraft:the_nether"]);
const point = z.object({
    dimension,
    x: z.number().int(),
    y: z.number().int(),
    z: z.number().int()
});
const trapSchema = point.extend({ placedAt: z.number() });
const evidenceSchema = z.object({
    name: z.string().max(40),
    hits: z.array(point.extend({ at: z.number() })),
    reportedHits: z.number().int().min(0),
    warnedAt: z.number().nullable(),
    bannedAt: z.number().nullable()
});

/** A list where one unreadable entry is dropped on its own, never the rest with it. */
function eachOf<T extends z.ZodTypeAny>(entry: T) {
    return z
        .array(z.unknown())
        .catch([])
        .transform((entries) =>
            entries.flatMap((one) => {
                const parsed = entry.safeParse(one);
                return parsed.success ? [parsed.data as z.output<T>] : [];
            })
        );
}

const storedSchema = z.object({
    settings: xraySettingsSchema.catch(DEFAULT_XRAY_SETTINGS),
    honeypots: eachOf(trapSchema),
    evidence: z
        .record(z.string(), z.unknown())
        .catch({})
        .transform((entries) => {
            const kept: Record<string, PlayerEvidence> = {};
            for (const [key, one] of Object.entries(entries)) {
                const parsed = evidenceSchema.safeParse(one);
                if (parsed.success) kept[key] = parsed.data;
            }
            return kept;
        }),
    cleanup: eachOf(trapSchema)
});

/** The stored state, or an empty one for a server that never had it. */
export function readXray(config: Record<string, unknown>): XrayState {
    const parsed = storedSchema.safeParse(config[XRAY_KEY]);
    return parsed.success ? parsed.data : EMPTY_XRAY;
}

/** A player name as a command can aim at it. */
export function isPlayerName(name: string): boolean {
    return /^[A-Za-z0-9_]{1,16}$/.test(name);
}

/** The live counters every look reads. Asking again for one that exists changes nothing. */
export function objectiveCommands(): string[] {
    return DIMENSIONS.map((dim) => {
        const kind = TRAP_KINDS[dim];
        return `scoreboard objectives add ${kind.objective} minecraft.mined:${kind.ore}`;
    });
}

/** Who mined the ore since the last look, and where they are now. */
export function minedSinceCommand(dim: Dimension): string {
    return `execute as @a[scores={${TRAP_KINDS[dim].objective}=1..}] run data get entity @s Pos`;
}

/** Back to nothing for everybody who mined it: by selector, so a name the game
 *  prints differently from how a command takes it is reset all the same. */
export function resetCounterCommand(dim: Dimension): string {
    const { objective } = TRAP_KINDS[dim];
    return `scoreboard players reset @a[scores={${objective}=1..}] ${objective}`;
}

/** Where every player is and which dimension they are in, for placing traps. */
export const WHERE_EVERYBODY_IS = [
    "execute as @a run data get entity @s Pos",
    "execute as @a run data get entity @s Dimension"
];

/** Whether a honeypot is still there. */
export function stillThereCommand(trap: Honeypot): string {
    return `execute in ${trap.dimension} if block ${trap.x} ${trap.y} ${trap.z} ${TRAP_KINDS[trap.dimension].ore}`;
}

/**
 * Put a honeypot at a point, only if the point and all six of its neighbours
 * are natural rock - so it touches no air, no water, no build and no cave. One
 * command: the game checks every condition and only then places it.
 */
export function placeCommand(dim: Dimension, x: number, y: number, z: number): string {
    const kind = TRAP_KINDS[dim];
    const around = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1]
    ]
        .map(([dx, dy, dz]) => `if block ${x + dx!} ${y + dy!} ${z + dz!} ${kind.neighbours}`)
        .join(" ");
    return `execute in ${dim} if block ${x} ${y} ${z} ${kind.rock} ${around} run setblock ${x} ${y} ${z} ${kind.ore}`;
}

/** Put the rock back where a honeypot was, if the ore is still there. */
export function removeCommand(trap: Honeypot): string {
    const kind = TRAP_KINDS[trap.dimension];
    return `execute in ${trap.dimension} if block ${trap.x} ${trap.y} ${trap.z} ${kind.ore} run setblock ${trap.x} ${trap.y} ${trap.z} ${kind.rock}`;
}

/**
 * The game's answer to a test: passed, failed, a place it has not loaded, or
 * something else. Only the game's own "Test failed" is failed: an empty,
 * cut-short or unfamiliar answer is unknown, and nothing is concluded from it.
 * A conditional `run` whose condition does not hold answers nothing at all, so
 * for placing and removing that is unknown too.
 */
export type TestAnswer = "passed" | "failed" | "unloaded" | "unknown";

export function readTest(output: string): TestAnswer {
    if (/not loaded|unloaded/i.test(output)) return "unloaded";
    if (/test passed|changed the block/i.test(output)) return "passed";
    if (/test failed/i.test(output)) return "failed";
    return "unknown";
}

/** Whether a message to a player reached them: they were online and the game took it. */
export function reachedPlayer(online: string, sent: string): boolean {
    return (
        readTest(online) === "passed" && !/no player|not found|unknown|incorrect|error/i.test(sent)
    );
}

/** A player online right now, by exact name. */
export function onlineCommand(name: string): string {
    return `execute if entity ${name}`;
}

/** `Steve has the following entity data: [1.5d, -58.0d, 30.2d]`, once per player. */
export function readPositions(output: string): { name: string; x: number; y: number; z: number }[] {
    const found: { name: string; x: number; y: number; z: number }[] = [];
    const pattern =
        /^(\S{1,40}) has the following entity data: \[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/gm;
    for (const match of stripFormatting(output).matchAll(pattern)) {
        const [x, y, z] = [match[2], match[3], match[4]].map(Number) as [number, number, number];
        if ([x, y, z].every(Number.isFinite)) found.push({ name: match[1] as string, x, y, z });
    }
    return found;
}

/** `Steve has the following entity data: "minecraft:the_nether"`, once per player. */
export function readDimensions(output: string): Map<string, string> {
    const found = new Map<string, string>();
    const pattern = /^(\S{1,40}) has the following entity data: "([a-z0-9_:./-]+)"/gm;
    for (const match of stripFormatting(output).matchAll(pattern)) {
        found.set(match[1] as string, match[2] as string);
    }
    return found;
}

function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
    return Math.hypot(a.x - (b.x + 0.5), a.y - (b.y + 0.5), a.z - (b.z + 0.5));
}

/** The honeypots near a player who just mined that ore: the ones to test. */
export function trapsNear(
    traps: readonly Honeypot[],
    dim: Dimension,
    at: { x: number; y: number; z: number },
    range: number = HIT_RANGE
): Honeypot[] {
    return traps.filter((trap) => trap.dimension === dim && distance(at, trap) <= range);
}

/**
 * Points to try for new honeypots around a player, out of their sight: a ring
 * between `PLACE_MIN_DISTANCE` and `PLACE_MAX_DISTANCE` blocks away, at the
 * dimension's ore depth. `random` is injected so it can be asserted.
 */
export function candidatePoints(
    dim: Dimension,
    around: { x: number; z: number },
    count: number,
    random: () => number = Math.random
): { x: number; y: number; z: number }[] {
    const kind = TRAP_KINDS[dim];
    const points: { x: number; y: number; z: number }[] = [];
    for (let index = 0; index < count; index += 1) {
        const angle = random() * Math.PI * 2;
        const reach = PLACE_MIN_DISTANCE + random() * (PLACE_MAX_DISTANCE - PLACE_MIN_DISTANCE);
        points.push({
            x: Math.floor(around.x + Math.cos(angle) * reach),
            y: kind.minY + Math.floor(random() * (kind.maxY - kind.minY + 1)),
            z: Math.floor(around.z + Math.sin(angle) * reach)
        });
    }
    return points;
}

/** The hits that still count, one per honeypot. */
export function countingHits(evidence: PlayerEvidence, now: number): Hit[] {
    const seen = new Set<string>();
    return evidence.hits.filter((hit) => {
        const key = `${hit.dimension}:${hit.x}:${hit.y}:${hit.z}`;
        if (seen.has(key) || now - hit.at > EVIDENCE_WINDOW_MS) return false;
        seen.add(key);
        return true;
    });
}

/** What a player's evidence adds up to, for the screen and for acting on it. */
export type Verdict = "clear" | "chance" | "confirmed";

export function verdictOf(evidence: PlayerEvidence | undefined, now: number): Verdict {
    if (!evidence) return "clear";
    const hits = countingHits(evidence, now).length;
    if (hits >= CONFIRM_HITS) return "confirmed";
    return hits > 0 ? "chance" : "clear";
}

/** What to do now that a player has a new hit, given the settings. */
export function actionsFor(
    evidence: PlayerEvidence,
    settings: XraySettings,
    now: number
): { report: boolean; warn: boolean; ban: boolean } {
    const hits = countingHits(evidence, now).length;
    const confirmed = hits >= CONFIRM_HITS;
    const banAt = Math.max(settings.banHits, BAN_HITS_MIN);
    return {
        report: confirmed && hits > evidence.reportedHits,
        warn: confirmed && settings.action !== "notify" && evidence.warnedAt === null,
        ban:
            settings.action === "warn-and-ban" &&
            hits >= banAt &&
            evidence.warnedAt !== null &&
            (evidence.bannedAt === null || evidence.bannedAt < evidence.warnedAt)
    };
}

/**
 * The game's own figures, for the table beside the evidence: how much of the
 * rock diamonds sit in each player has mined, and how many diamonds. Context
 * only - see the top of this file for why it is never a verdict.
 */
export interface MiningFigures {
    readonly diamonds: number;
    readonly deepRock: number;
    readonly debris: number;
    readonly netherRock: number;
}

export function miningFigures(statsJson: string): MiningFigures | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(statsJson);
    } catch {
        return null;
    }
    const mined = ((parsed as { stats?: Record<string, unknown> })?.stats?.["minecraft:mined"] ??
        {}) as Record<string, unknown>;
    const count = (...keys: string[]) =>
        keys.reduce((sum, key) => sum + (Number(mined[`minecraft:${key}`]) || 0), 0);
    return {
        diamonds: count("diamond_ore", "deepslate_diamond_ore"),
        deepRock: count("deepslate", "tuff"),
        debris: count("ancient_debris"),
        netherRock: count("netherrack", "basalt", "blackstone")
    };
}
