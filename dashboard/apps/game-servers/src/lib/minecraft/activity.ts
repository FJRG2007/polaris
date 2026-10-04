/**
 * Who on a Minecraft server is actually playing, and who has gone quiet.
 *
 * The game has no idea of idleness, so it is read from outside: where each player
 * is, which way they are looking, and the two running counts of damage taken and
 * dealt. Somebody mining in silence is still moving or turning their head; a
 * player who has done none of those for a few minutes is away from the keyboard.
 *
 * One record per server in this process, shared by what asks: the events, which
 * only start while enough people are playing, and the players list, which says
 * who is AFK. Looked at no more often than every so often however many ask.
 */

import * as plan from "./events/plan";
import * as commands from "./events/commands";
import type { ServerContainer } from "./service";
import { fresh } from "../fresh";

/** The least time between two looks at one server, however many ask. */
const LOOK_EVERY_MS = 15_000;

const activity = new Map<string, Map<string, plan.Seen>>();
const lookedAt = new Map<string, number>();
const combatReady = new Set<string>();

/** What was last seen of a server's players, keyed by lowercased name. */
export function seenOn(installedAppId: string): ReadonlyMap<string, plan.Seen> | null {
    return activity.get(installedAppId) ?? null;
}

/** Look at everybody on the server now, and remember it. */
export async function lookAt(
    installedAppId: string,
    server: ServerContainer
): Promise<Map<string, plan.Seen>> {
    const positions = commands.readWhere(await server.say([commands.WHERE]));
    const facing = commands.readFacing(await server.say([commands.FACING]));
    const dimensions = commands.readDimensions(await server.say([commands.DIMENSIONS]));
    // Made once per server this process has looked at; adding one that is there
    // already is refused by the game, harmlessly.
    if (!combatReady.has(installedAppId)) {
        await server.sayAll(commands.COMBAT_OBJECTIVES);
        combatReady.add(installedAppId);
    }
    const hurt = commands.readScores(await server.say([commands.READ_HURT]));
    const hit = commands.readScores(await server.say([commands.READ_HIT]));
    const now = Date.now();
    const seen = plan.observe(activity.get(installedAppId) ?? new Map(), positions, facing, now, {
        dimensions,
        hurt,
        hit
    });
    activity.set(installedAppId, seen);
    lookedAt.set(installedAppId, now);
    return seen;
}

/**
 * The fighting an event did itself, forgotten once it is over.
 *
 * A duel, a boss or a wave raises the same count of damage dealt that a fight
 * out in the world does, so everybody who had just played one read as in a
 * fight for the next minute and a half - and the next event was refused with
 * "in a fight" for players standing at home doing nothing. Looked at once more
 * here, so the count is caught up with what the event dealt and only a blow
 * struck after it counts, and then the event's own players are taken out of
 * any fight that look saw.
 */
export async function forgetEventFights(
    installedAppId: string,
    server: ServerContainer,
    names: readonly string[]
): Promise<void> {
    const seen = await lookAt(installedAppId, server);
    const played = new Set(names.map((name) => name.toLowerCase()));
    const next = new Map(seen);
    for (const [key, one] of seen) {
        if (played.has(key) && one.fightingAt !== null) next.set(key, { ...one, fightingAt: null });
    }
    activity.set(installedAppId, next);
}

/** The same, unless somebody looked a moment ago. */
export async function lookIfDue(
    installedAppId: string,
    server: ServerContainer
): Promise<ReadonlyMap<string, plan.Seen>> {
    const last = lookedAt.get(installedAppId);
    const kept = activity.get(installedAppId);
    if (kept && last !== undefined && fresh(last, LOOK_EVERY_MS)) return kept;
    return lookAt(installedAppId, server);
}

/**
 * The players on now who are AFK by the events' own rule - not moved or turned
 * for `afkMinutes` - and since when, by the name the game gives them. Counted
 * from the first look for somebody never seen to move, so a player standing
 * still from the moment Polaris started watching becomes AFK after the same few
 * minutes as anybody else.
 */
export function idleSince(
    seen: ReadonlyMap<string, plan.Seen>,
    afkMinutes: number,
    now: number
): Record<string, number> {
    const found: Record<string, number> = {};
    for (const one of seen.values()) {
        const acted = one.movedAt ?? one.since;
        if (now - acted >= afkMinutes * 60_000) found[one.name] = acted;
    }
    return found;
}

/** For a test: forget every server, as a fresh process has. */
export function forgetActivity(): void {
    activity.clear();
    lookedAt.clear();
    combatReady.clear();
}
