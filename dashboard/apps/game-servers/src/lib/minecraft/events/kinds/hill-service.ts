/**
 * Playing a king of the hill: its circle put on the world's own ground, or on a
 * platform of its own over the sea when there is none (`hill.ts`), then either
 * walked to by whoever wants it, or - with "fists only" - played by who joined,
 * brought to it empty-handed and unable to die (`arena-service` brings them in
 * and sends them back; this plays it).
 */

import * as inServer from "../in-server";
import { formatDuration } from "../../../figures";
import * as hill from "./hill";
import * as arrival from "./arrival";
import * as arena from "./arena";
import * as catalog from "../catalog";
import * as speech from "../../speech";
import * as written from "../messages";
import * as commands from "../commands";
import * as said from "./hill-messages";
import type * as stored from "../state";
import * as search from "../place-search";
import { EventStopped, type KindContext } from "./arena-service";

/** What players read, in one language or - given `speech.EVERY` - in every one. */
const messages = speech.spoken(written);
const hillMessages = speech.spoken(said);

/** Ticks a platform's chunks are waited for before its site is given up. */
const LOAD_WAITS = 5;

const waits = new Map<string, number>();

function optionsOf(run: stored.EventRun): catalog.EventOptions<"king-of-the-hill"> {
    return run.preset.options as catalog.EventOptions<"king-of-the-hill">;
}

/**
 * The circle's place, over a few ticks. Played with fists only (the default):
 * a platform floating `hill.LIFT` over the highest thing under it - a build, a
 * tree, the sea - built into air proven empty, like every other arena. Walked
 * to: the world's own ground, or a platform on the sea. Answers whether it is
 * ready. Throws once nowhere would do.
 */
export async function raiseHill(ctx: KindContext): Promise<boolean> {
    const run = ctx.run;
    const { radius, place, fistsOnly } = optionsOf(run);
    if (run.place && run.arena) return true;
    // Walked to rather than brought to: on the ground where there is any, and
    // over the sea at sea level where there is not - a hill in the sky could
    // not be walked to.
    if (!fistsOnly && !run.overSea) {
        const found = await ctx.findPlace(place, hill.DISTANCE, radius, "ground", true);
        if (found === null) return false;
        if (found !== "failed") {
            ctx.run = { ...ctx.run, arena: { box: hill.bounds(found, radius), blocks: [] } };
            await ctx.persist();
            await announce(ctx, found);
            return true;
        }
        ctx.run = { ...ctx.run, overSea: true, placeTries: 0, target: null, place: null };
        await ctx.persist();
        await ctx.server.sayAll([commands.CLEAR_MARK]);
        return false;
    }
    if (!run.place) {
        const found = fistsOnly
            ? await ctx.findPlace(
                  place,
                  hill.DISTANCE,
                  radius + hill.MARGIN,
                  "air",
                  true,
                  hill.LIFT
              )
            : await ctx.findPlace(place, hill.DISTANCE, radius + hill.MARGIN, "open", true);
        if (found === "failed")
            throw new EventStopped(fistsOnly ? search.NO_AIR : search.NO_GROUND);
        return false;
    }
    return buildPlatform(ctx, run.place, radius);
}

/**
 * The platform over the water at `at`, the first air over its surface: the
 * site held loaded, the air over it counted - anything but air and it is given
 * up - written down as the event's, then built, only into air. The circle then
 * stands on it.
 */
async function buildPlatform(ctx: KindContext, at: stored.Point, radius: number): Promise<boolean> {
    const run = ctx.run;
    const floor = hill.platformBox(at, radius);
    const proof = hill.proofBox(at, radius);
    if (proof.y2 > arena.worldTop(await ctx.atLeast([1, 18]))) {
        await giveUp(ctx, at, "tooHigh");
        return false;
    }
    if (!run.site) {
        // Written down before it is loaded, so whatever ends the event lets it go.
        ctx.run = { ...run, site: proof };
        await ctx.persist();
        await ctx.server.sayAll([arena.forceloadArea(proof, true)]);
        return false;
    }
    let solid = 0;
    let loading = false;
    for (const piece of arena.slices(proof)) {
        const count = arena.readCount(await ctx.server.say([arena.solidCount(piece)]));
        if (count === "unloaded") loading = true;
        else solid += count ?? Number.POSITIVE_INFINITY;
    }
    const waited = waits.get(run.id) ?? 0;
    if (solid === 0 && loading && waited < LOAD_WAITS) {
        waits.set(run.id, waited + 1);
        return false;
    }
    waits.delete(run.id);
    if (solid > 0 || loading) {
        await giveUp(ctx, at, solid > 0 ? "occupied" : "unloaded");
        return false;
    }
    // Ours, written down before a block goes in.
    const built: stored.Arena = { box: floor, blocks: [...hill.PLATFORM_BLOCKS] };
    ctx.run = { ...ctx.run, arena: built };
    await ctx.persist();
    // Paced inside the server where the Polaris mod can (`in-server.build`).
    const raised = await inServer.build(ctx.server, [
        ...hill.platformDecor(at, radius).map((one) => arena.fillKeep(one.box, one.block)),
        arena.fillKeep(floor, hill.PLATFORM_BLOCK)
    ]);
    const probe = `execute in minecraft:overworld if block ${at.x} ${at.y} ${at.z} ${hill.PLATFORM_BLOCK}`;
    if (!raised || commands.readTest(await ctx.server.say([probe])) !== "passed") {
        // A protected area refuses blocks without a word.
        await ctx.server.sayAll(arena.teardown(built));
        ctx.run = { ...ctx.run, arena: null };
        await giveUp(ctx, at, "refused");
        return false;
    }
    // The circle stands on it.
    const top = { ...at, y: at.y + 1 };
    ctx.run = { ...ctx.run, place: top };
    await ctx.persist();
    // Walked to, it is told where; played with fists only, everybody is
    // brought up to it, and where it floats is nothing to them.
    if (optionsOf(ctx.run).fistsOnly) await ctx.server.sayAll([commands.CLEAR_MARK]);
    else await announce(ctx, top);
    return true;
}

async function giveUp(
    ctx: KindContext,
    at: stored.Point,
    why: Parameters<KindContext["giveUpPlace"]>[1]
): Promise<void> {
    if (ctx.run.site) await ctx.server.sayAll([arena.forceloadArea(ctx.run.site, false)]);
    ctx.run = { ...ctx.run, site: null };
    await ctx.giveUpPlace(at, why);
}

async function announce(ctx: KindContext, at: stored.Point): Promise<void> {
    await ctx.server.sayAll([
        commands.CLEAR_MARK,
        commands.say(messages.tag(ctx.language) + messages.circleAt(at.x, at.y, at.z, ctx.language))
    ]);
}

/**
 * The platform taken away, and its site let go: only its block, only inside its
 * own box. For the king of the hill anybody walks to, from the stored run - so
 * after a restart too. Played with fists only, the arena's own end does it.
 */
export function platformCleanup(run: stored.EventRun): string[] {
    if (run.preset.kind !== "king-of-the-hill" || catalog.hillFistsOnly(run.preset)) return [];
    const lines: string[] = [];
    if (run.arena && run.arena.blocks.length > 0) {
        lines.push(arena.forceloadArea(run.arena.box, true));
        lines.push(...arena.teardown(run.arena));
        lines.push(arena.forceloadArea(run.arena.box, false));
    }
    if (run.site) lines.push(arena.forceloadArea(run.site, false));
    return lines;
}

/** Everybody told how far the circle is and which way, in their own action bar. */
async function guide(
    ctx: KindContext,
    place: stored.Point,
    radius: number,
    lines: string[]
): Promise<void> {
    for (const one of commands.readWhere(await ctx.server.say([commands.IN_OVERWORLD]))) {
        const away = Math.hypot(one.x - (place.x + 0.5), one.z - (place.z + 0.5));
        lines.push(
            commands.actionbarFor(
                one.name,
                commands.inHill(one, place, radius)
                    ? messages.hillInside(ctx.language)
                    : messages.hillGuide(
                          Math.round(away),
                          commands.headingTo(one, { x: place.x + 0.5, z: place.z + 0.5 }),
                          ctx.language
                      )
            )
        );
    }
}

/**
 * One tick of the king of the hill anybody walks to: the circle found, then
 * drawn, everybody in it given the time, and everybody told the way.
 */
export async function walkInTick(
    ctx: KindContext,
    seconds: number,
    lines: string[]
): Promise<string | null> {
    if (!(await raiseHill(ctx))) return null;
    const place = ctx.run.place!;
    const { radius } = optionsOf(ctx.run);
    lines.push(...commands.hillTick(place, radius, seconds));
    await guide(ctx, place, radius, lines);
    return null;
}

/** Where each of them comes in, round the circle. */
export function entrySpotsFor(run: stored.EventRun): arena.Spot[] {
    return hill.entrySpots(run.place!, optionsOf(run).radius, run.joined.length);
}

/** Where each starts: inside the whole ring, round its middle (`hill.startSpots`). */
export function startSpotsFor(run: stored.EventRun): arena.Spot[] {
    return hill.startSpots(run.place!, optionsOf(run).radius, run.joined.length);
}

/** What bringing one of them in says and does, once where they were is kept. */
export function enterLines(
    run: stored.EventRun,
    name: string,
    index: number,
    overGround: boolean,
    language: speech.Speech
): string[] {
    const spot = startSpotsFor(run)[index % Math.max(1, run.joined.length)]!;
    return [
        ...hill.enterLines(name, spot, overGround),
        ...arena.titleTo(
            name,
            hillMessages.enterTitle(language),
            hillMessages.enterSubtitle(language)
        ),
        arena.tellTo(name, messages.tag(language) + hillMessages.enterLine(language))
    ];
}

/**
 * How long everybody is waited for on the platform before it starts anyway -
 * the same wait every event that brings its players in has (`arrival`).
 */
export const ARRIVAL_MS = arrival.ARRIVAL_MS;

/** Whether somebody stands on the platform: over its floor, at its height. */
export function onHill(run: stored.EventRun, at: { x: number; y: number; z: number }): boolean {
    return hill.onPlatform(at, run.place!, optionsOf(run).radius);
}

/**
 * The hill while everybody is brought up: nobody hurt, nothing counted, and
 * whoever is up already and was knocked off put back on their own spot.
 */
export async function holdLines(
    ctx: KindContext,
    where: readonly { name: string; x: number; y: number; z: number }[],
    arrived: (name: string) => boolean
): Promise<string[]> {
    const run = ctx.run;
    const place = run.place!;
    const { radius } = optionsOf(run);
    const lines = [
        ...hill.protectLines(),
        hill.catchLine(place, radius),
        ...arena.keepThrown(hill.bounds(place, radius))
    ];
    const spots = startSpotsFor(run);
    const overGround = await ctx.atLeast([1, 19, 4]);
    const here = new Map(where.map((one) => [one.name.toLowerCase(), one]));
    for (const one of run.entrants) {
        const at = here.get(one.name.toLowerCase());
        if (!at || !arrived(one.name) || !hill.strayed(at, place, radius)) continue;
        lines.push(
            ...hill
                .enterLines(one.name, spots[one.side % spots.length]!, overGround)
                .filter((line) => line.includes(" tp "))
        );
    }
    return lines;
}

/**
 * "Go!" on the hill: each put back on their own spot round the circle, so
 * nobody who was up first is any closer to it.
 */
export async function goLines(ctx: KindContext): Promise<string[]> {
    const run = ctx.run;
    const spots = startSpotsFor(run);
    const overGround = await ctx.atLeast([1, 19, 4]);
    return [
        ...run.entrants.flatMap((one) =>
            hill
                .enterLines(one.name, spots[one.side % spots.length]!, overGround)
                .filter((line) => line.includes(" tp "))
        ),
        ...arena.titleTo(
            `@a[tag=${arena.IN_ARENA}]`,
            hillMessages.goTitle(ctx.language),
            hillMessages.goSubtitle(ctx.language)
        )
    ];
}

/** What the ring is played with: who was brought in, and the event's options. */
export function ringSettings(run: stored.EventRun): hill.RingSettings {
    const options = optionsOf(run);
    return {
        seed: run.id,
        radius: options.radius,
        players: run.entrants.length,
        rounds: options.rounds,
        shrinks: options.shrinks,
        moves: options.moves
    };
}

/** The ring now, from the time since "Go!". */
export function ringNow(run: stored.EventRun, now: number): hill.Ring {
    return hill.ringAt(ringSettings(run), run.endsAt - run.startsAt, now - run.startsAt);
}

/**
 * One tick of the king of the ring played with fists only: nobody can be hurt,
 * whoever was knocked right off is brought back to the edge, and the ring
 * shrunk, moved and drawn where it is now (`hill.ringAt`). Time in it counts
 * for everybody in it, three times over for whoever is in it alone - double at
 * the end of a round - and the one ahead glows and wears the crown. Between
 * rounds everybody goes back to their spot and nothing counts.
 */
export async function fightTick(ctx: KindContext, seconds: number, lines: string[]): Promise<void> {
    const run = ctx.run;
    const platform = run.place!;
    const options = optionsOf(run);
    const { radius } = options;
    const ring = ringNow(run, Date.now());
    const center = hill.ringCenter(platform, ring);
    // As it was built: whole, in the middle, nobody ahead.
    const was = run.ring ?? { round: 1, dx: 0, dz: 0, radius, sprint: false, leader: null };
    // Knocked off: back at the edge. A new round: inside the whole ring.
    const spots = entrySpotsFor(run);
    const starts = startSpotsFor(run);
    const room = hill.bounds(platform, radius);
    const overGround = await ctx.atLeast([1, 19, 4]);
    lines.push(
        ...(ring.pause
            ? [...hill.protectLines(), hill.catchLine(platform, radius)]
            : hill.protectLines(center, ring.radius)),
        ...commands.hillMarks(center, ring.radius),
        ...arena.keepThrown(room),
        ...commands.hostilesOut(room)
    );
    if (!ring.pause)
        lines.push(...hill.scoreLines(center, ring.radius, seconds * (ring.sprint ? 2 : 1)));
    if (ring.radius !== was.radius || ring.dx !== was.dx || ring.dz !== was.dz) {
        const floor = { ...platform, y: platform.y - 1 };
        lines.push(...hill.redrawLines(floor, radius, { ...center, y: floor.y }, ring.radius));
    }
    const everybody = `@a[tag=${arena.IN_ARENA}]`;
    if (ring.round > was.round) {
        // A new round: everybody back on their own spot, the ring whole again.
        lines.push(
            ...run.entrants.flatMap((one, index) =>
                hill
                    .enterLines(one.name, starts[index % starts.length]!, overGround)
                    .filter((line) => line.includes(" tp "))
            ),
            ...arena.titleTo(
                everybody,
                hillMessages.roundTitle(ring.round, options.rounds, ctx.language),
                hillMessages.roundSubtitle(options.shrinks, options.moves, ctx.language)
            ),
            commands.sound(commands.SOUNDS.start)
        );
    } else if (ring.sprint && !(was.sprint && was.round === ring.round)) {
        lines.push(
            ...arena.titleTo(
                everybody,
                hillMessages.sprintTitle(ctx.language),
                hillMessages.sprintSubtitle(ctx.language)
            ),
            commands.sound(commands.SOUNDS.tick)
        );
    }
    const where = commands
        .readWhere(await ctx.server.say([commands.IN_OVERWORLD]))
        .filter((one) => run.entrants.some((entrant) => lower(entrant.name) === lower(one.name)));
    const here = new Map(where.map((one) => [lower(one.name), one]));
    const inside = where.filter((one) => commands.inHill(one, center, ring.radius)).length;
    for (const [index, one] of run.entrants.entries()) {
        const at = here.get(lower(one.name));
        if (!at) continue;
        if (hill.strayed(at, platform, radius)) {
            lines.push(
                ...hill
                    .enterLines(one.name, spots[index % spots.length]!, overGround)
                    .filter((line) => line.includes(" tp ")),
                arena.actionbarTo(one.name, hillMessages.backOnHill(ctx.language))
            );
            continue;
        }
        lines.push(
            commands.actionbarFor(
                one.name,
                ring.pause
                    ? hillMessages.nextRound(ctx.language)
                    : commands.inHill(at, center, ring.radius)
                      ? inside > 1
                          ? hillMessages.contested(ctx.language)
                          : messages.ringInside(ctx.language)
                      : messages.ringGuide(
                            Math.round(
                                Math.hypot(at.x - (center.x + 0.5), at.z - (center.z + 0.5))
                            ),
                            commands.headingTo(at, { x: center.x + 0.5, z: center.z + 0.5 }),
                            ctx.language
                        )
            )
        );
    }
    // The time each has held it, as the side panel counts it, kept in the run for the end.
    const scores = commands.readScores(await ctx.server.say([commands.READ_SCORES]));
    const points: Record<string, number> = {};
    for (const one of run.entrants) {
        const score = [...scores].find(([name]) => lower(name) === lower(one.name))?.[1];
        if (score !== undefined) points[one.name] = score;
    }
    if (JSON.stringify(points) !== JSON.stringify(run.points) && Object.keys(points).length > 0) {
        // The side panel reads each time held as a time, not a count of
        // seconds, where the game can show text beside a score (1.20.3).
        if (await ctx.atLeast([1, 20, 3])) {
            const shown = Object.entries(points)
                .filter(([name, score]) => run.points?.[name] !== score)
                .map(([name, score]) =>
                    commands.scoreShownAs(
                        name,
                        commands.SCORE,
                        formatDuration(score * 1000, ctx.home)
                    )
                );
            if (shown.length > 0) await ctx.server.sayAll(shown);
        }
        ctx.run = { ...ctx.run, points: { ...run.points, ...points } };
    }
    // The one ahead glows, and wears the crown where it can be put straight
    // on: from 1.17, where their head was emptied on the way in.
    const leader = hill.leaderOf(ctx.run.points);
    if (leader) lines.push(`effect give ${leader} minecraft:glowing 3 0 true`);
    if (leader !== was.leader) {
        const crowns = run.marker !== null && (await ctx.atLeast([1, 17]));
        if (was.leader) {
            lines.push(`effect clear ${was.leader} minecraft:glowing`);
            if (crowns) lines.push(arena.clearMarked(was.leader, hill.CROWN, run.marker!));
        }
        if (leader) {
            if (crowns)
                lines.push(
                    // A golden helmet wears out with every blow taken: the
                    // crown has to last the whole round on the leader's head.
                    arena.equipMarked(leader, "armor.head", hill.CROWN, run.marker!, arena.LASTS)
                );
            lines.push(
                commands.say(messages.tag(ctx.language) + hillMessages.leads(leader, ctx.language))
            );
        }
    }
    const kept: NonNullable<stored.EventRun["ring"]> = {
        round: ring.round,
        dx: ring.dx,
        dz: ring.dz,
        radius: ring.radius,
        sprint: ring.sprint,
        leader
    };
    if (JSON.stringify(kept) !== JSON.stringify(run.ring) || ctx.run !== run) {
        ctx.run = { ...ctx.run, ring: kept };
        await ctx.persist();
    }
}

function lower(name: string): string {
    return name.toLowerCase();
}
