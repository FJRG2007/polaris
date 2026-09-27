/**
 * Flying and teleporting a player was not allowed to, told apart from
 * everything in the game that legitimately looks like either.
 *
 * Polaris watches through the same channel as the honeypots: vanilla commands
 * over RCON every few seconds, so it works on every Java server Polaris runs,
 * Paper or modded, with nothing installed on it. What that channel sees is a
 * sample of each player's position every few seconds - not every movement
 * packet the way an anticheat plugin does - so this catches the blatant cases
 * and says so, and never acts on its own: every incident is listed with where
 * and when, for somebody to look at.
 *
 * Flying is hovering: the same player seen in the air, with at least three
 * blocks of air under them, on `HOVER_SAMPLES` looks in a row, never falling
 * more than `HOVER_MAX_DROP` between two of them and moving at all. Ruled out
 * before a sample is even taken (see `AIRBORNE_COMMAND`): creative and
 * spectator, anybody the game allows to fly (`mayfly` - which is also what a
 * `/fly` plugin grants), an elytra glide, a vehicle, levitation and slow
 * falling. A player whose connection dropped mid-jump freezes where they were,
 * so a player who does not move at all is never counted; and operators are
 * left out altogether.
 *
 * A teleport is a jump between two looks further than anybody could have
 * walked, ridden, glided or thrown a pearl, in the same dimension. Ruled out: a
 * change of dimension (a portal), a respawn (from the look that saw them die
 * until they are next seen moving, since the death screen can hold a player
 * for as long as they like before the respawn moves them), the first
 * `JOIN_GRACE_MS` after joining (a server that sends whoever connects to its
 * spawn), a vehicle or an elytra at any point since the last look, the End
 * (its gateways move you a thousand blocks), operators, and anything the
 * server log explains - a `/tp` by an
 * operator or the console (the game logs those while `logAdminCommands` is on,
 * which is its default; with it off the teleport check stands down, because an
 * operator's teleport can no longer be told apart), or a teleport command
 * somebody ran through a plugin (`/home`, `/spawn`, `/tpa`...). An ender pearl
 * stasis chamber is the one legitimate thing left that looks the same, and the
 * screen says so.
 *
 * Pure: every command and every decision can be asserted without a server.
 */

import { z } from "zod";
import { stripFormatting } from "./parse";

/** How long an incident counts, the same fortnight as the honeypots. */
export const MOVEMENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Looks in a row a player must be seen hovering before it is an incident. At
 *  one look every four seconds, that is eight seconds in the air or more. */
export const HOVER_SAMPLES = 3;

/** The most a hovering player may drop between two looks. Anybody falling for
 *  four seconds has dropped over a hundred blocks. */
export const HOVER_MAX_DROP = 4;

/** How far a hovering player must have moved across the looks, so a player
 *  frozen by a lost connection is never counted. */
export const HOVER_MIN_TRAVEL = 0.5;

/** Looks further apart than this say nothing about movement: the loop stalled. */
export const MAX_LOOK_GAP_MS = 15_000;

/** How long after joining a jump is still the server's own doing: a spawn,
 *  lobby or login plugin moving whoever just connected. */
export const JOIN_GRACE_MS = 60_000;

/** How far a player must be seen moving, after the look that saw them die, to
 *  have respawned without a jump (a bed beside where they fell). A body on the
 *  death screen does not move. */
export const RESPAWN_MOVE = 1;

/** Kept per player, oldest dropped first. */
export const MAX_INCIDENTS = 50;

export const DEATH_OBJECTIVE = "polaris_mv_death";
export const GLIDE_OBJECTIVE = "polaris_mv_glide";

/** The counters the watch reads: deaths, and distance flown on an elytra. */
export function movementObjectiveCommands(): string[] {
    return [
        `scoreboard objectives add ${DEATH_OBJECTIVE} deathCount`,
        `scoreboard objectives add ${GLIDE_OBJECTIVE} minecraft.custom:minecraft.aviate_one_cm`
    ];
}

/**
 * Everybody in the air who has no reason to be: air where their feet are and
 * three blocks of air under them, air at and under every corner of them too
 * (somebody sneaking or bridging at an edge stands with their middle over
 * nothing, and somebody on a slab, a bed or a path has their feet inside the
 * block they stand on), and none of what legitimately keeps somebody up. Both spellings of the
 * status effects are asked for - `active_effects` since 1.20.2, `ActiveEffects`
 * (25 levitation, 28 slow falling) before it - and the one a version does not
 * know simply never matches.
 */
export const AIRBORNE_COMMAND = [
    "execute as @a[gamemode=!creative,gamemode=!spectator] at @s",
    "if block ~ ~ ~ minecraft:air",
    "if block ~ ~-1 ~ minecraft:air if block ~ ~-2 ~ minecraft:air if block ~ ~-3 ~ minecraft:air",
    "if block ~0.3 ~ ~0.3 minecraft:air if block ~-0.3 ~ ~0.3 minecraft:air",
    "if block ~0.3 ~ ~-0.3 minecraft:air if block ~-0.3 ~ ~-0.3 minecraft:air",
    "if block ~0.3 ~-1 ~0.3 minecraft:air if block ~-0.3 ~-1 ~0.3 minecraft:air",
    "if block ~0.3 ~-1 ~-0.3 minecraft:air if block ~-0.3 ~-1 ~-0.3 minecraft:air",
    "unless entity @s[nbt={FallFlying:1b}]",
    "unless entity @s[nbt={abilities:{mayfly:1b}}]",
    "unless entity @s[nbt={RootVehicle:{}}]",
    'unless entity @s[nbt={active_effects:[{id:"minecraft:levitation"}]}]',
    'unless entity @s[nbt={active_effects:[{id:"minecraft:slow_falling"}]}]',
    "unless entity @s[nbt={ActiveEffects:[{Id:25}]}]",
    "unless entity @s[nbt={ActiveEffects:[{Id:28}]}]",
    "run data get entity @s Pos"
].join(" ");

/** Everybody on a horse, in a boat or a minecart right now. */
export const RIDING_COMMAND =
    "execute as @a[nbt={RootVehicle:{}}] run data get entity @s Dimension";

/** Who died since the last look, and who glided on an elytra. */
export function sinceCommand(objective: string): string {
    return `execute as @a[scores={${objective}=1..}] run data get entity @s Dimension`;
}

/** Reset only the players that were read, so a death between the read and the
 *  reset is still there at the next look. A name the game would not take
 *  written out falls back to everybody counted. */
export function resetCommands(objective: string, names: Iterable<string>): string[] {
    return [...names].map((name) =>
        /^[A-Za-z0-9_]{1,16}$/.test(name)
            ? `scoreboard players reset ${name} ${objective}`
            : `scoreboard players reset @a[scores={${objective}=1..}] ${objective}`
    );
}

/** Whether the game writes operators' commands to its log. */
export const LOG_ADMIN_COMMAND = "gamerule logAdminCommands";

/** `Gamerule logAdminCommands is currently set to: true`. Null for any other answer. */
export function readLogAdmin(output: string): boolean | null {
    const match = /is currently set to:\s*(true|false)/i.exec(stripFormatting(output));
    return match ? match[1]!.toLowerCase() === "true" : null;
}

export interface Sample {
    readonly dimension: string;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly at: number;
}

/** What the watch remembers about one player between looks. */
export interface Track {
    readonly last: Sample | null;
    /** The looks in a row they were seen hovering. */
    readonly hover: readonly Sample[];
    /** Whether the hover going on now was already recorded, so one long flight
     *  is one incident. */
    readonly flagged: boolean;
    /** When they joined, where the watch saw them arrive; null for whoever was
     *  already online when it started. */
    readonly joinedAt: number | null;
    /** The look that saw them die, until they are seen respawned. */
    readonly diedAt: number | null;
}

export const NEW_TRACK: Track = {
    last: null,
    hover: [],
    flagged: false,
    joinedAt: null,
    diedAt: null
};

function gap(left: Sample, right: Sample): number {
    return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

/**
 * One more look at a player: whether they are hovering, and whether this look
 * is the one that makes it an incident. `airborne` is their sample when
 * `AIRBORNE_COMMAND` listed them, null when it did not.
 */
export function nextHover(
    track: Track,
    airborne: Sample | null
): { track: Track; flying: boolean } {
    if (!airborne) return { track: { ...track, hover: [], flagged: false }, flying: false };
    const previous = track.hover.at(-1);
    const continues =
        previous !== undefined &&
        previous.dimension === airborne.dimension &&
        airborne.at - previous.at <= MAX_LOOK_GAP_MS &&
        previous.y - airborne.y <= HOVER_MAX_DROP;
    const hover = continues ? [...track.hover, airborne].slice(-HOVER_SAMPLES) : [airborne];
    const flagged = continues ? track.flagged : false;
    let travel = 0;
    for (let index = 1; index < hover.length; index += 1)
        travel += gap(hover[index - 1]!, hover[index]!);
    const flying = !flagged && hover.length >= HOVER_SAMPLES && travel >= HOVER_MIN_TRAVEL;
    return { track: { ...track, hover, flagged: flagged || flying }, flying };
}

/** The furthest a player could legitimately cover on foot between two looks:
 *  sprint-jumping, a trident in the rain, a thrown pearl. Vehicles and elytras
 *  are ruled out separately, since nothing short of that bound would hold them. */
export function reachIn(ms: number): number {
    return 100 + 12 * (ms / 1000);
}

/** Whether a jump this look is still the server moving somebody who just joined. */
export function joining(track: Track, now: number): boolean {
    return track.joinedAt !== null && now - track.joinedAt <= JOIN_GRACE_MS;
}

/**
 * Since when a player's next jump is their respawn, after this look: from the
 * look that saw them die until they are seen moving on a later one. The look
 * that saw the death may have sampled them still alive and running, so only
 * movement after it counts.
 */
export function respawnAfter(track: Track, sample: Sample, died: boolean): number | null {
    if (died) return sample.at;
    const since = track.diedAt;
    const previous = track.last;
    if (since === null || !previous || previous.at <= since) return since;
    const moved = previous.dimension !== sample.dimension || gap(previous, sample) > RESPAWN_MOVE;
    return moved ? null : since;
}

/** Whether the jump between two looks at the same player is a teleport. */
export function isTeleport(previous: Sample, next: Sample): boolean {
    if (previous.dimension !== next.dimension) return false;
    if (next.dimension === "minecraft:the_end") return false;
    const elapsed = next.at - previous.at;
    if (elapsed <= 0 || elapsed > MAX_LOOK_GAP_MS) return false;
    return gap(previous, next) > reachIn(elapsed);
}

/** Commands a player can run through a plugin that move somebody: their own or
 *  another player's request to be moved. */
const TELEPORT_VERBS =
    /issued server command: \/(?:[\w-]+:)?(?:tp\w*|teleport\w*|home\w*|spawn|warp\w*|back|rtp|wild|randomtp|top|jump|call|tpr)\b/i;

/**
 * Whether the log written since the last look explains a player's jump: an
 * operator or the console teleported them, somebody ran a teleport command
 * through a plugin, `/spreadplayers` ran, or they left and came back.
 */
export function explainedByLog(log: string, name: string): boolean {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // The game writes the display name, which a team can wrap in a prefix or a
    // suffix, and a selector that moved several players as a count.
    const teleported = new RegExp(`Teleported (?:.*\\b${escaped}\\b.*|\\d+ entities) to `, "i");
    const came = new RegExp(`\\b${escaped} (?:joined|left) the game`, "i");
    return stripFormatting(log)
        .split("\n")
        .some(
            (line) =>
                teleported.test(line) ||
                came.test(line) ||
                TELEPORT_VERBS.test(line) ||
                /Spread \d+ /.test(line)
        );
}

const dimensionSchema = z.string().max(64);

export const incidentSchema = z.object({
    kind: z.enum(["flying", "teleport"]),
    dimension: dimensionSchema,
    x: z.number().int(),
    y: z.number().int(),
    z: z.number().int(),
    /** For a teleport, how far it went. */
    distance: z.number().int().min(0).nullable(),
    at: z.number()
});

export type Incident = z.infer<typeof incidentSchema>;

export const movementEvidenceSchema = z.object({
    name: z.string().max(40),
    incidents: z.array(incidentSchema).max(MAX_INCIDENTS),
    /** When the owner was told this player looks likely to be cheating, so they
     *  are told once rather than at every incident after. */
    reportedAt: z.number().nullable().default(null)
});

export type MovementEvidence = z.output<typeof movementEvidenceSchema>;

/** The incidents that still count. */
export function countingIncidents(evidence: MovementEvidence | undefined, now: number): Incident[] {
    return (evidence?.incidents ?? []).filter((one) => now - one.at <= MOVEMENT_WINDOW_MS);
}

/** Whether the owner was already told about what still counts. Once everything
 *  that was reported has left the window, a new run of incidents is told again. */
export function alreadyReported(evidence: MovementEvidence | undefined, now: number): boolean {
    const reportedAt = evidence?.reportedAt ?? null;
    if (reportedAt === null) return false;
    return countingIncidents(evidence, now).some((one) => one.at <= reportedAt);
}

/** Add one, keeping the newest `MAX_INCIDENTS`. */
export function withIncident(
    evidence: MovementEvidence | undefined,
    name: string,
    incident: Incident
): MovementEvidence {
    return {
        name,
        incidents: [...(evidence?.incidents ?? []), incident].slice(-MAX_INCIDENTS),
        reportedAt: evidence?.reportedAt ?? null
    };
}

/** An incident as it is stored, rounded to the block it happened at. */
export function incidentAt(
    kind: Incident["kind"],
    sample: Sample,
    distance: number | null
): Incident {
    return {
        kind,
        dimension: sample.dimension,
        x: Math.floor(sample.x),
        y: Math.floor(sample.y),
        z: Math.floor(sample.z),
        distance: distance === null ? null : Math.round(distance),
        at: sample.at
    };
}

/** How far apart two looks are, for the teleport's own row. */
export function distanceBetween(previous: Sample, next: Sample): number {
    return gap(previous, next);
}
