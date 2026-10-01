/**
 * Playing a parkour race or a spleef: taking the names of who joins, building
 * the structure where it can harm nothing, bringing the players in, watching
 * them, and putting every block and every player back where it was.
 *
 * The loop in `events-service.ts` owns the clock, the place-finding and the
 * saving; it hands this the few of those it needs (`StageTools`). What is built
 * and who was moved is written into the run (`stage`) before it happens, so a
 * restart at any point can still undo it - see `stage.ts` for the guarantees.
 */

import * as stage from "./stage";
import * as spleef from "./spleef";
import * as parkour from "./parkour";
import * as stash from "./stash";
import * as stashService from "./stash-service";
import * as catalog from "../catalog";
import * as commands from "../commands";
import * as speech from "../../speech";
import * as written from "../messages";
import type { EventRun, Point } from "../state";
import type { ServerContainer } from "../../service";
import type { PlaceRefusal } from "../place-search";

/** What players read, in one language or - given `speech.EVERY` - in every one. */
const messages = speech.spoken(written);

/** The event cannot go ahead - too few joined, the structure would not stand -
 *  and ends as called off, with everything undone. */
export class CalledOff extends Error {}

/** What of the loop this needs: the run, which it changes, and the language. */
export interface StageLoop {
    run: EventRun;
    /** Every language: each line is split for its readers on the way out. */
    readonly language: speech.Speech;
}

export interface StageTools {
    persist(): Promise<void>;
    /** A site found by the same rules every event uses; null while still looking.
     *  Throws once it has given up. */
    findSite(place: catalog.EventPlace, radius: number): Promise<Point | null>;
    /** A site that would not do, for the reason given: let go of, and another
     *  looked for. Throws once there have been too many. */
    giveUpSite(point: Point, why?: PlaceRefusal): Promise<void>;
    /** What was said in the chat since the last time this was asked. */
    chat(): Promise<string | null>;
    /** Who, in lower case, is still owed a trip back from an earlier stage or arena. */
    owed(): Promise<ReadonlySet<string>>;
    flavour(): Promise<stage.Flavour>;
    /** The item syntax that worked, when the version's guess did not. */
    itemsWork(items: stage.Flavour["items"]): void;
    /** Whether this server can keep what players carry (`item`, from 1.17). */
    canStash(): Promise<boolean>;
    /** Whose run a kept bag belongs to, for its database copy. */
    readonly stashOwner: stashService.StashOwner;
}

/** How many ticks the area gets to load before the site is given up. */
const LOAD_WAITS = 3;
/** Never built closer to the ground than this, even under a low build limit. */
const LEAST_HEIGHT = 20;
/** How far outside the volume somebody can wander before they count as gone. */
const STRAY = 16;
/** The pause on the spleef floor before the shovels are handed out. */
const READY_MS = 6_000;

function state(loop: StageLoop): stage.StageState {
    return loop.run.stage ?? stage.EMPTY_STAGE;
}

function change(loop: StageLoop, patch: Partial<stage.StageState>): stage.StageState {
    const next = { ...state(loop), ...patch };
    loop.run = { ...loop.run, stage: next };
    return next;
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

function tell(name: string, line: string): string {
    return `tellraw ${name} ${commands.text(line)}`;
}

function soundFor(name: string, id: string): string {
    return `execute as ${name} at @s run playsound ${id} master @s ~ ~ ~ 1 1`;
}

// ------------------------------------------------------------------ the structure

type Layout =
    | {
          readonly kind: "parkour";
          readonly course: parkour.Course;
          readonly boxes: readonly stage.Box[];
          readonly volume: stage.Volume;
          readonly reach: number;
      }
    | {
          readonly kind: "spleef";
          readonly arena: spleef.Arena;
          readonly boxes: readonly stage.Box[];
          readonly volume: stage.Volume;
          readonly reach: number;
      };

function layoutAt(run: EventRun, site: { x: number; z: number }, y: number): Layout {
    if (run.preset.kind === "parkour") {
        const course = parkour.course(
            run.preset.options as catalog.EventOptions<"parkour">,
            run.id,
            site,
            y
        );
        return {
            kind: "parkour",
            course,
            boxes: course.boxes,
            volume: course.volume,
            reach: course.reach
        };
    }
    const floor = spleef.arena(run.preset.options as catalog.EventOptions<"spleef">, site, y);
    return {
        kind: "spleef",
        arena: floor,
        boxes: floor.boxes,
        volume: floor.volume,
        reach: floor.reach
    };
}

/** The structure as it stands, from where it was put. */
function built(run: EventRun): Layout | null {
    const origin = run.stage?.origin;
    return origin ? layoutAt(run, origin, origin.y) : null;
}

// ------------------------------------------------------------------ joining

function calls(said: string | null): { name: string; call: stage.Call }[] {
    return said ? stage.readCalls(said) : [];
}

/** The joins and leaves said since the last look - but no join from anybody
 *  still owed a trip back from an earlier stage or arena, who is not taken
 *  anywhere else until they are back where they started. */
async function heardFrom(tools: StageTools): Promise<{ name: string; call: stage.Call }[]> {
    const heard = calls(await tools.chat());
    if (!heard.some((one) => one.call === "join")) return heard;
    const owed = await tools.owed();
    return heard.filter((one) => one.call !== "join" || !owed.has(one.name.toLowerCase()));
}

/** Joins and leaves before anybody is brought in. Answers whether the list changed. */
function noteCalls(
    loop: StageLoop,
    heard: readonly { name: string; call: stage.Call }[],
    lines: string[]
): boolean {
    let joined = [...state(loop).joined];
    let changed = false;
    for (const { name, call } of heard) {
        const listed = joined.some((one) => same(one, name));
        if (call === "join" && !listed) {
            joined = [...joined, name];
            lines.push(tell(name, messages.tag(loop.language) + messages.joinedYou(loop.language)));
            changed = true;
        } else if (call === "leave" && listed) {
            joined = joined.filter((one) => !same(one, name));
            lines.push(tell(name, messages.tag(loop.language) + messages.leftYou(loop.language)));
            changed = true;
        }
    }
    if (changed) change(loop, { joined });
    return changed;
}

/** The countdown: who has typed `join`, and how many are in so far. */
export async function countdownTick(
    loop: StageLoop,
    tools: StageTools,
    lines: string[]
): Promise<void> {
    if (noteCalls(loop, await heardFrom(tools), lines)) await tools.persist();
    lines.push(
        `title @a actionbar ${commands.text(messages.joinedBar(state(loop).joined.length, loop.language))}`
    );
}

// ------------------------------------------------------------------ one tick

/**
 * One tick of a parkour race or a spleef. Answers a sentence when it is decided
 * before its time is up, and null while it goes on. Throws `CalledOff` when it
 * cannot go ahead at all.
 */
export async function stageTick(
    loop: StageLoop,
    server: ServerContainer,
    tools: StageTools,
    now: number,
    lines: string[]
): Promise<string | null> {
    const heard = await heardFrom(tools);
    if (!state(loop).built) {
        if (noteCalls(loop, heard, lines)) await tools.persist();
        await raise(loop, server, tools, now, lines);
        return null;
    }
    lines.push(stage.PROTECT_INSIDE);
    if (Math.floor(now / 2_000) % 5 === 0) lines.push(stage.FEED_INSIDE);
    const layout = built(loop.run);
    if (!layout) return null;
    lines.push(stage.floatDown(layout.volume, 10), ...commands.hostilesOut(layout.volume));
    return layout.kind === "parkour"
        ? parkourTick(loop, server, tools, layout.course, layout.volume, heard, now, lines)
        : spleefTick(loop, server, tools, layout.arena, layout.volume, heard, now, lines);
}

/**
 * Up to the point everybody is in: enough players, a site, the volume proved
 * empty, the structure built, the players brought in. One step a tick where it
 * has to wait for the world; the rest at once.
 */
async function raise(
    loop: StageLoop,
    server: ServerContainer,
    tools: StageTools,
    now: number,
    lines: string[]
): Promise<void> {
    const { preset } = loop.run;
    const language = loop.language;
    const needed = catalog.joinersNeeded(preset);
    const joined = state(loop).joined.length;
    if (joined < needed) {
        lines.push(
            commands.say(
                messages.tag(language) + messages.notEnoughJoined(joined, needed, language)
            )
        );
        throw new CalledOff(`Only ${joined} joined; it needs ${needed}`);
    }
    const options = preset.options as { place: catalog.EventPlace; height: number };

    const origin = state(loop).origin;
    if (!origin) {
        const reach = layoutAt(loop.run, { x: 0, z: 0 }, 0).reach;
        const ground = await tools.findSite(options.place, reach);
        if (!ground) return;
        const { top } = await tools.flavour();
        // As high as asked, or as high as the build limit leaves room for.
        let y = ground.y + options.height;
        const over = layoutAt(loop.run, ground, y).volume.y2 - (top - 1);
        if (over > 0) y -= over;
        if (y - ground.y < LEAST_HEIGHT) {
            await tools.giveUpSite(ground, "tooHigh");
            return;
        }
        const area = stage.areaOf(layoutAt(loop.run, ground, y).volume);
        // Written down before the area is held, so whatever ends the event
        // lets go of it.
        change(loop, { origin: { x: ground.x, y, z: ground.z }, area, waits: 0 });
        await tools.persist();
        lines.push(stage.holdArea(area), commands.CLEAR_MARK);
        return;
    }

    const layout = layoutAt(loop.run, origin, origin.y);
    if (!(await provedEmpty(loop, server, tools, layout.volume))) return;

    // Written down first, then built - into air only.
    const before = state(loop).boxes;
    change(loop, { boxes: [...before, ...layout.boxes] });
    await tools.persist();
    let whole = true;
    for (const box of layout.boxes) {
        if (stage.fillCount(await server.say([stage.buildLine(box)])) !== stage.volumeOf(box)) {
            whole = false;
        }
    }
    change(loop, { built: true });
    if (!whole) throw new CalledOff("Its structure could not be built whole");

    const brought = await admit(loop, server, tools, state(loop).joined, now, lines, needed);
    if (brought < needed) {
        lines.push(
            commands.say(
                messages.tag(language) + messages.notEnoughJoined(brought, needed, language)
            )
        );
        throw new CalledOff(`Only ${brought} could be brought in; it needs ${needed}`);
    }
    if (preset.kind === "spleef") change(loop, { goAt: now + READY_MS });
    await tools.persist();
}

/**
 * Whether the whole volume is empty air, proved by filling it with the probe
 * block using `keep` and comparing the count to its size - then taking the
 * probe out again either way. A site that is not empty is given up.
 */
async function provedEmpty(
    loop: StageLoop,
    server: ServerContainer,
    tools: StageTools,
    volume: stage.Volume
): Promise<boolean> {
    const probes = stage.probeBoxes(volume);
    const kept = state(loop).boxes;
    change(loop, { boxes: [...kept, ...probes] });
    await tools.persist();
    let filled = 0;
    let unloaded = false;
    for (const box of probes) {
        const count = stage.fillCount(await server.say([stage.buildLine(box)]));
        if (count === null) unloaded = true;
        else filled += count;
    }
    let cleared = true;
    for (const box of probes) {
        if (stage.fillCount(await server.say([stage.removeLine(box)])) === null) cleared = false;
    }
    if (cleared) change(loop, { boxes: kept });
    const current = state(loop);
    if (!unloaded && cleared && filled === stage.volumeOf(volume)) return true;
    if (unloaded && current.waits < LOAD_WAITS) {
        change(loop, { waits: current.waits + 1 });
        await tools.persist();
        return false;
    }
    // The probe would not come out again: it stays written down, with the area
    // it needs held, for the end of the event to take out.
    if (!cleared) throw new CalledOff("The air it needs could not be checked");
    // Not empty - a tree, a hill, something of somebody's - or never loaded:
    // somewhere else.
    const ground = loop.run.place;
    const area = current.area;
    change(loop, { origin: null, area: null, waits: 0 });
    await tools.persist();
    if (area) await server.sayAll([stage.releaseArea(area)]);
    if (ground) await tools.giveUpSite(ground, unloaded ? "unloaded" : "occupied");
    return false;
}

/**
 * Bring players in: where each of them is written down first, then they are
 * moved. Anybody offline, or in creative or spectator, is left out. Answers how
 * many came in.
 */
async function admit(
    loop: StageLoop,
    server: ServerContainer,
    tools: StageTools,
    names: readonly string[],
    now: number,
    lines: string[],
    /** How many it needs: too few to play, and nobody is moved at all. */
    needed = 0
): Promise<number> {
    const layout = built(loop.run);
    if (!layout || names.length === 0) return 0;
    const where = commands.readWhere(await server.say([commands.WHERE]));
    const facing = commands.readFacing(await server.say([commands.FACING]));
    const dimensions = commands.readDimensions(await server.say([commands.DIMENSIONS]));
    const modes = stage.readGameModes(await server.say([stage.GAME_MODES]));
    const current = state(loop);
    const fresh: stage.Saved[] = [];
    for (const name of names) {
        if (current.saved.some((one) => same(one.name, name))) continue;
        const saved = stage.savedFrom(name, where, facing, dimensions, modes);
        if (saved) fresh.push(saved);
        else if (where.some((one) => same(one.name, name)))
            lines.push(
                tell(name, messages.tag(loop.language) + messages.notSurvival(loop.language))
            );
    }
    if (fresh.length === 0) return 0;
    const racers = [...current.racers];
    for (const one of fresh) {
        const at = racers.findIndex((racer) => same(racer.name, one.name));
        if (at >= 0) racers[at] = { ...racers[at]!, outAt: null };
        else
            racers.push({
                name: one.name,
                since: now,
                best: 0,
                checkpoint: 0,
                finishedAt: null,
                outAt: null,
                points: 0
            });
    }
    change(loop, {
        saved: [...current.saved, ...fresh],
        racers,
        joined: current.joined.filter((name) => !fresh.some((one) => same(one.name, name)))
    });
    // Nobody is moved until where they were is kept.
    await tools.persist();
    if (current.saved.length + fresh.length < needed) return fresh.length;
    // Nor until what they carry is put away too (`stash`): they come in
    // empty-handed. One at a time, and straight in - nobody left standing about
    // empty-handed at home, free to put their armor back on, while everybody
    // else's is put away.
    const stashing = await tools.canStash();
    const places = layout.kind === "spleef" ? spleef.spots(layout.arena, fresh.length) : [];
    if (layout.kind === "parkour") await server.sayAll(parkour.SCORES_ADDED);
    const brought: string[] = [];
    for (const [index, one] of fresh.entries()) {
        if (stashing && !(await stashSaved(loop, server, tools, one.name, false))) continue;
        const racer = state(loop).racers.find((each) => same(each.name, one.name))!;
        const spot =
            layout.kind === "parkour"
                ? parkour.spotOn(layout.course, racer.checkpoint)
                : places[index]!;
        await server.sayAll([
            ...stage.admitLines(one.name, spot),
            `title ${one.name} times 5 50 15`,
            layout.kind === "parkour"
                ? `title ${one.name} subtitle ${commands.text(messages.parkourSubtitle(loop.language))}`
                : `title ${one.name} subtitle ${commands.text(messages.spleefReadySubtitle(loop.language))}`,
            `title ${one.name} title ${commands.text(
                layout.kind === "parkour"
                    ? messages.goTitle(loop.language)
                    : messages.spleefReadyTitle(loop.language)
            )}`,
            // Their checkpoint, once they are on it, for the quick look.
            ...(layout.kind === "parkour" ? parkour.racerScores(one.name, racer.checkpoint) : [])
        ]);
        brought.push(one.name);
    }
    // And once in, a last look: whatever turned up on them on the way is put
    // away with the rest; anybody it cannot be taken from is sent back out.
    if (!stashing) return brought.length;
    let inside = 0;
    for (const name of brought) if (await stashSaved(loop, server, tools, name, true)) inside += 1;
    return inside;
}

/**
 * One player's own things put away (`stash`) - or, `inside`, what turned up on
 * them on the way in put away with the rest. Answers whether they are in:
 * somebody whose things cannot all be put away is kept out - told why, sent
 * back where they were if they had been brought in, and handed back whatever
 * was taken.
 */
async function stashSaved(
    loop: StageLoop,
    server: ServerContainer,
    tools: StageTools,
    name: string,
    inside: boolean
): Promise<boolean> {
    const saved = state(loop).saved.find((one) => same(one.name, name));
    if (!saved) return false;
    if (!inside && saved.stash) return true;
    const result = await stashService.stashIn(
        server,
        tools.stashOwner,
        name,
        async (kept) => {
            change(loop, {
                saved: state(loop).saved.map((each) =>
                    same(each.name, name) ? { ...each, stash: kept } : each
                )
            });
            await tools.persist();
        },
        inside ? saved.stash : null
    );
    if (!result.refused) return true;
    await server.say([
        tell(
            name,
            messages.tag(loop.language) +
                messages.keptOut(result.refused.why, result.refused.items, loop.language)
        )
    ]);
    loop.run = {
        ...loop.run,
        keptOut: [
            ...(loop.run.keptOut ?? []).filter((each) => !same(each.name, name)),
            { name, why: result.refused.why, items: result.refused.items }
        ]
    };
    // Back where they were - or, never moved, left there - with whatever was
    // taken given back; never counted as racing.
    await sendHome(loop, server, tools, name);
    change(loop, { racers: state(loop).racers.filter((one) => !same(one.name, name)) });
    await tools.persist();
    return false;
}

/** Back to where they were, if they are on to be moved. Answers whether they were. */
async function sendHome(
    loop: StageLoop,
    server: ServerContainer,
    tools: StageTools,
    name: string
): Promise<boolean> {
    const saved = state(loop).saved.find((one) => same(one.name, name));
    if (!saved) return true;
    const keep = async (kept: stash.Stash | null) => {
        change(loop, {
            saved: state(loop).saved.map((one) =>
                same(one.name, name) ? { ...one, stash: kept } : one
            )
        });
        await tools.persist();
    };
    if (!(await returnOne(server, saved, (await tools.flavour()).items, loop.language, keep)))
        return false;
    change(loop, { saved: state(loop).saved.filter((one) => !same(one.name, name)) });
    return true;
}

async function returnOne(
    server: ServerContainer,
    saved: stage.Saved,
    items: stage.Flavour["items"],
    language: speech.Speech,
    keep: (kept: stash.Stash | null) => Promise<void>
): Promise<boolean> {
    // Their own things back only once they are home and down: nothing is given
    // back to a player who could still fall with it.
    const giveBack = async (): Promise<boolean> => {
        const down = await stashService.settle(server, saved.name, (name) =>
            stage.fallProof(name, 5)
        );
        if (!saved.stash) return true;
        if (!down) return false;
        const how = await stashService.giveBack(server, saved.name, saved.stash, keep);
        return how === "done" || how === "failed";
    };
    // Nothing from here on can make them fall to their death.
    await server.sayAll(stage.fallProof(saved.name));
    // Sent home already, by an end that stopped before it gave everything back:
    // not moved again, only given what they are still owed.
    const say = (line: string) => server.say([line]);
    if (await commands.alreadyBack(say, saved.name, stage.IN_ARENA)) return giveBack();
    // The event's items off, then home, then - there - their own game mode.
    await server.sayAll([stage.clearMarked(saved.name, items)]);
    if (!stage.returned(await server.say([stage.returnLine(saved)]))) return false;
    await server.sayAll(
        stage.afterReturnLines(
            saved,
            items,
            messages.tag(language) + messages.backWhereYouWere(language)
        )
    );
    return giveBack();
}

/** Gone from the arena by their own doing: another world, or far off. */
function strayed(
    at: { x: number; y: number; z: number },
    dimension: string | undefined,
    volume: stage.Volume
): boolean {
    if (dimension !== undefined && dimension !== "minecraft:overworld") return true;
    return (
        at.x < volume.x1 - STRAY ||
        at.x > volume.x2 + 1 + STRAY ||
        at.z < volume.z1 - STRAY ||
        at.z > volume.z2 + 1 + STRAY ||
        at.y > volume.y2 + 2 * STRAY
    );
}

// ------------------------------------------------------------------ parkour

async function parkourTick(
    loop: StageLoop,
    server: ServerContainer,
    tools: StageTools,
    course: parkour.Course,
    volume: stage.Volume,
    heard: readonly { name: string; call: stage.Call }[],
    now: number,
    lines: string[]
): Promise<string | null> {
    const language = loop.language;
    let dirty = false;
    // A late joiner is welcome - their time counts from when they start - and
    // a call to leave is answered at once.
    for (const { name, call } of heard) {
        const racer = state(loop).racers.find((one) => same(one.name, name));
        const inside = racer !== undefined && racer.outAt === null;
        if (call === "join" && !inside) {
            if (racer?.finishedAt) continue;
            await admit(loop, server, tools, [name], now, lines);
        } else if (call === "leave" && inside) {
            await sendHome(loop, server, tools, name);
            markOut(loop, name, now, 0);
            lines.push(tell(name, messages.tag(language) + messages.leftYou(language)));
            dirty = true;
        }
    }

    const where = commands.readWhere(await server.say([stage.ARENA_WHERE]));
    const dimensions = commands.readDimensions(await server.say([stage.ARENA_DIMENSIONS]));
    // What the quick look (`quickLines`) has already marked: each racer's
    // checkpoint as the game keeps it.
    const scored = lowered(commands.readScores(await server.say([parkour.READ_CHECKPOINTS])));
    const jumps = course.platforms.length - 1;
    const checkpoints = course.checkpoints.length;
    // When a racer the quick look saw finish stepped onto it, from the game's
    // own ticks - asked only when somebody has.
    let ticks: { at: Map<string, number>; now: number | null } | null = null;
    const finishedAt = async (racer: stage.Racer): Promise<number> => {
        ticks ??= {
            at: lowered(commands.readScores(await server.say([parkour.READ_FINISH_TICKS]))),
            now: commands.readDaytime(await server.say([parkour.READ_GAME_TIME]))
        };
        const tick = ticks.at.get(racer.name.toLowerCase());
        if (tick === undefined || ticks.now === null) return now;
        return Math.max(racer.since, Math.min(now, now - Math.max(0, ticks.now - tick) * 50));
    };
    for (const racer of state(loop).racers) {
        if (racer.outAt !== null) continue;
        const at = where.find((one) => same(one.name, racer.name));
        if (!at) continue;
        if (strayed(at, dimensions.get(at.name), volume)) {
            await sendHome(loop, server, tools, racer.name);
            markOut(loop, racer.name, now, 0);
            dirty = true;
            continue;
        }
        if (racer.finishedAt !== null) {
            lines.push(
                commands.actionbarFor(
                    racer.name,
                    messages.finishedBar(
                        messages.clock((racer.finishedAt - racer.since) / 1000),
                        language
                    )
                )
            );
            continue;
        }
        const game = scored.get(racer.name.toLowerCase());
        // Fell, and the quick look does not know them - a run from before it
        // kept a score: back to the last checkpoint from here.
        if (game === undefined && at.y < course.floor + 0.5) {
            lines.push(
                stage.moveLine(racer.name, parkour.spotOn(course, racer.checkpoint)),
                tell(racer.name, messages.tag(language) + messages.backToCheckpoint(language))
            );
            continue;
        }
        let next = racer;
        // A checkpoint the quick look marked, and told them of already.
        if (game !== undefined && game > racer.checkpoint && game <= jumps) {
            next = { ...next, checkpoint: game, best: Math.max(next.best, game) };
            if (game === jumps) next = { ...next, finishedAt: await finishedAt(racer) };
        }
        // Anything it missed, from where they stand.
        const on = parkour.platformUnder(course, at);
        let sounded = next.finishedAt !== null;
        if (on !== null && on > next.best) {
            next = { ...next, best: on };
            const role = course.platforms[on]!.role;
            if ((role === "checkpoint" || role === "finish") && on > next.checkpoint) {
                next = { ...next, checkpoint: on };
                const reached = parkour.checkpointsBy(course, on);
                lines.push(
                    `title ${racer.name} times 5 30 10`,
                    `title ${racer.name} subtitle ${commands.text(" ")}`,
                    `title ${racer.name} title ${commands.text(messages.checkpointTitle(reached, checkpoints, language))}`,
                    soundFor(racer.name, commands.SOUNDS.tick),
                    `scoreboard players set ${racer.name} ${parkour.CHECKPOINT_SCORE} ${on}`
                );
            }
            if (role === "finish" && next.finishedAt === null) {
                next = { ...next, finishedAt: now };
                sounded = false;
            }
        }
        if (next.finishedAt !== null) {
            const place = state(loop).racers.filter((one) => one.finishedAt !== null).length + 1;
            lines.push(
                commands.say(
                    messages.tag(language) +
                        messages.finishedLine(
                            racer.name,
                            messages.clock((next.finishedAt - racer.since) / 1000),
                            place,
                            language
                        )
                )
            );
            if (!sounded) lines.push(soundFor(racer.name, commands.SOUNDS.win));
        }
        if (next !== racer) {
            change(loop, {
                racers: state(loop).racers.map((one) => (same(one.name, racer.name) ? next : one))
            });
            lines.push(commands.setScore(racer.name, next.best));
            dirty = true;
        }
        if (next.finishedAt === null) {
            lines.push(
                commands.actionbarFor(
                    racer.name,
                    messages.parkourBar(
                        parkour.checkpointsBy(course, next.best),
                        checkpoints,
                        next.best,
                        jumps,
                        language
                    )
                )
            );
        }
    }
    if (dirty) await tools.persist();
    const racers = state(loop).racers;
    if (racers.length > 0 && racers.every((one) => one.finishedAt !== null || one.outAt !== null)) {
        lines.push(commands.say(messages.tag(language) + messages.everybodyDone(language)));
        return "Everybody finished or dropped out";
    }
    return null;
}

/** A read's names in lower case, for matching against racers. */
function lowered(scores: ReadonlyMap<string, number>): Map<string, number> {
    return new Map([...scores].map(([name, score]) => [name.toLowerCase(), score]));
}

/**
 * The quick look at a parkour race, run far oftener than the tick: whoever fell
 * is sent back to their checkpoint, and whoever stepped onto a checkpoint or
 * the finish is told and has it marked - with selectors over the checkpoints the
 * game keeps (`parkour.CHECKPOINT_SCORE`), so it reads nothing and is one batch
 * whatever the number of racers. The tick picks up what it marked. Nothing
 * while no racer is still going.
 */
export function quickLines(loop: StageLoop): string[] {
    const layout = built(loop.run);
    if (!layout || layout.kind !== "parkour" || !state(loop).built) return [];
    if (!state(loop).racers.some((one) => one.outAt === null && one.finishedAt === null)) return [];
    const language = loop.language;
    const course = layout.course;
    const total = course.checkpoints.length;
    const { fell, reached } = parkour.quickSelectors(course);
    const as = (selector: string) => `execute in minecraft:overworld as ${selector}`;
    const lines: string[] = [];
    for (const one of fell) {
        const spot = one.spot;
        lines.push(
            `${as(one.selector)} run tellraw @s ${commands.text(messages.tag(language) + messages.backToCheckpoint(language))}`,
            `${as(one.selector)} run tp @s ${spot.x.toFixed(3)} ${spot.y.toFixed(3)} ${spot.z.toFixed(3)} ${spot.yaw.toFixed(1)} 0.0`
        );
    }
    for (const one of reached) {
        const count = parkour.checkpointsBy(course, one.checkpoint);
        const sound = one.finish ? commands.SOUNDS.win : commands.SOUNDS.tick;
        lines.push(
            `${as(one.selector)} run title @s times 5 30 10`,
            `${as(one.selector)} run title @s subtitle ${commands.text(" ")}`,
            `${as(one.selector)} run title @s title ${commands.text(messages.checkpointTitle(count, total, language))}`,
            `${as(one.selector)} at @s run playsound ${sound} master @s ~ ~ ~ 1 1`,
            ...(one.finish
                ? [
                      `${as(one.selector)} store result score @s ${parkour.FINISH_TICK} run time query gametime`
                  ]
                : []),
            // Marked last: the lines before it still find them.
            `${as(one.selector)} run scoreboard players set @s ${parkour.CHECKPOINT_SCORE} ${one.checkpoint}`
        );
    }
    return lines;
}

function markOut(loop: StageLoop, name: string, now: number, points: number): void {
    change(loop, {
        racers: state(loop).racers.map((one) =>
            same(one.name, name) && one.outAt === null ? { ...one, outAt: now, points } : one
        )
    });
}

// ------------------------------------------------------------------ spleef

async function spleefTick(
    loop: StageLoop,
    server: ServerContainer,
    tools: StageTools,
    floor: spleef.Arena,
    volume: stage.Volume,
    heard: readonly { name: string; call: stage.Call }[],
    now: number,
    lines: string[]
): Promise<string | null> {
    const language = loop.language;
    const leaving = new Set<string>();
    for (const { name, call } of heard) {
        const racer = state(loop).racers.find((one) => same(one.name, name));
        if (call === "leave" && racer && racer.outAt === null)
            leaving.add(racer.name.toLowerCase());
        else if (call === "join" && !racer)
            lines.push(tell(name, messages.tag(language) + messages.tooLate(language)));
    }

    const where = commands.readWhere(await server.say([stage.ARENA_WHERE]));
    const dimensions = commands.readDimensions(await server.say([stage.ARENA_DIMENSIONS]));
    let dirty = false;

    const current = state(loop);
    if (!current.armed && current.goAt !== null && now >= current.goAt) {
        const { items } = await tools.flavour();
        for (const racer of current.racers) {
            if (racer.outAt !== null) continue;
            await handShovel(server, tools, racer.name, items);
            lines.push(
                `title ${racer.name} subtitle ${commands.text(" ")}`,
                `title ${racer.name} title ${commands.text(messages.spleefGo(language))}`,
                soundFor(racer.name, commands.SOUNDS.start)
            );
        }
        change(loop, { armed: true });
        dirty = true;
    }

    const out: string[] = [];
    for (const racer of state(loop).racers) {
        if (racer.outAt !== null) continue;
        const at = where.find((one) => same(one.name, racer.name));
        if (
            leaving.has(racer.name.toLowerCase()) ||
            !at ||
            strayed(at, dimensions.get(at.name), volume) ||
            spleef.fell(floor, at.y)
        ) {
            out.push(racer.name);
        }
    }
    if (out.length > 0) {
        // Everybody out on the same look shares the place: one point for each
        // player already out, and one for taking part.
        const points = state(loop).racers.filter((one) => one.outAt !== null).length + 1;
        for (const name of out) markOut(loop, name, now, points);
        const left = state(loop).racers.filter((one) => one.outAt === null).length;
        for (const name of out) {
            await sendHome(loop, server, tools, name);
            lines.push(
                commands.say(messages.tag(language) + messages.spleefOut(name, left, language)),
                `title ${name} subtitle ${commands.text(" ")}`,
                `title ${name} title ${commands.text(messages.spleefOutTitle(language))}`
            );
        }
        dirty = true;
    }

    const standing = state(loop).racers.filter((one) => one.outAt === null);
    for (const racer of standing) {
        lines.push(
            commands.actionbarFor(
                racer.name,
                state(loop).armed
                    ? messages.spleefBar(standing.length, language)
                    : messages.spleefReadyTitle(language)
            )
        );
    }
    if (dirty) await tools.persist();
    if (!state(loop).armed || standing.length > 1) return null;
    const winner = standing[0];
    if (!winner) {
        lines.push(commands.say(messages.tag(language) + messages.nobodyStanding(language)));
        return "Nobody was left standing";
    }
    lines.push(commands.say(messages.tag(language) + messages.lastStanding(winner.name, language)));
    return `${winner.name} was the last one standing`;
}

/** The marked shovel, in the syntax this server takes - the other tried once if
 *  the version's guess was wrong, and remembered. */
async function handShovel(
    server: ServerContainer,
    tools: StageTools,
    name: string,
    items: stage.Flavour["items"]
): Promise<void> {
    if (commands.gaveIt(await server.say([stage.markedShovel(name, items)]))) return;
    const other = items === "components" ? "nbt" : "components";
    if (commands.gaveIt(await server.say([stage.markedShovel(name, other)])))
        tools.itemsWork(other);
}

// ------------------------------------------------------------------ the end

/**
 * Undo what is left of an arena: everybody still owed a trip back who is on now
 * is sent back (their marked items cleared, their game mode given back), then
 * every box is taken out - latest first, so a plate goes before what it stands
 * on - only where its block still is. Answers what could not be done yet: a
 * player who is offline, a box whose chunks did not load. Safe to run again.
 */
export async function settle(
    server: ServerContainer,
    leftover: stage.Leftover,
    flavour: stage.Flavour,
    language: speech.Speech
): Promise<stage.Leftover | null> {
    let saved = leftover.saved;
    if (saved.length > 0) {
        const online = new Set(
            commands
                .readWhere(await server.say([commands.WHERE]))
                .map((one) => one.name.toLowerCase())
        );
        const still: stage.Saved[] = [];
        for (const one of saved) {
            let current = one;
            const back =
                online.has(one.name.toLowerCase()) &&
                (await returnOne(server, one, flavour.items, language, async (kept) => {
                    current = { ...current, stash: kept };
                }));
            if (!back) still.push(current);
        }
        saved = still;
    }
    let boxes = leftover.boxes;
    let area = leftover.area;
    if (boxes.length > 0) {
        if (area) await server.sayAll([stage.holdArea(area)]);
        // Whatever is still standing on it - a pet, a mob - floats down
        // rather than falls when it goes.
        const bounds = stage.boundsOf(boxes);
        if (bounds)
            await server.sayAll([stage.floatDown(bounds, 60), ...stage.fallProofOver(bounds)]);
        const standing: stage.Box[] = [];
        for (const box of [...boxes].reverse()) {
            if (stage.fillCount(await server.say([stage.removeLine(box)])) === null)
                standing.unshift(box);
        }
        boxes = standing;
    }
    if (boxes.length === 0 && area) {
        await server.sayAll([stage.releaseArea(area)]);
        area = null;
    }
    return saved.length === 0 && boxes.length === 0 && !area
        ? null
        : { ...leftover, saved, boxes, area };
}

/** The final scores, and everybody who took part. */
export function results(run: EventRun): { scores: Map<string, number>; took: string[] } {
    const racers = run.stage?.racers ?? [];
    const scores = new Map<string, number>();
    for (const one of racers) {
        if (run.preset.kind === "parkour") {
            scores.set(
                one.name,
                one.finishedAt !== null
                    ? parkour.finishScore((one.finishedAt - one.since) / 1000)
                    : one.best
            );
        } else {
            scores.set(one.name, one.outAt === null ? racers.length : one.points);
        }
    }
    return { scores, took: racers.map((one) => one.name) };
}

/** The standings for the screen while it runs: jumps made, or points so far. */
export function standings(run: EventRun): { name: string; score: number }[] {
    const course = run.preset.kind === "parkour" ? built(run) : null;
    const jumps = course?.kind === "parkour" ? course.course.platforms.length - 1 : 0;
    return (run.stage?.racers ?? [])
        .map((one) => ({
            name: one.name,
            score:
                run.preset.kind === "parkour"
                    ? one.finishedAt !== null
                        ? jumps
                        : one.best
                    : one.outAt === null
                      ? (run.stage?.racers.length ?? 0)
                      : one.points
        }))
        .sort((left, right) => right.score - left.score);
}

/** A score the way the podium says it: a finish time, or how far they got. */
export function scoreText(
    kind: catalog.EventKind,
    score: number,
    language: speech.Speech
): string | null {
    if (kind === "parkour") {
        if (parkour.isFinish(score)) return messages.clock(parkour.FINISH_BASE - score);
        return speech.pickIn({ en: `${score} jumps`, es: `${score} saltos` }, language);
    }
    if (kind === "spleef")
        return speech.pickIn(
            { en: `${score} ${score === 1 ? "point" : "points"}`, es: `${score} puntos` },
            language
        );
    return null;
}
