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
import * as snowballPack from "./snowball-pack";
import * as snowballPackService from "./snowball-pack-service";
import * as parkour from "./parkour";
import * as tntRun from "./tnt-run";
import * as tntRunSaid from "./tnt-run-messages";
import * as dropper from "./dropper";
import * as dropperSaid from "./dropper-messages";
import * as boatRace from "./boat-race";
import * as boatRaceSaid from "./boat-race-messages";
import * as netherMaze from "./nether-maze";
import * as netherMazeSaid from "./nether-maze-messages";
import * as radar from "./radar";
import * as acidRain from "./acid-rain";
import * as acidRainSaid from "./acid-rain-messages";
import * as stash from "./stash";
import * as arrival from "./arrival";
import * as stashService from "./stash-service";
import * as pace from "./pace";
import * as catalog from "../catalog";
import * as commands from "../commands";
import * as speech from "../../speech";
import * as written from "../messages";
import type { EventRun, Point } from "../state";
import type { ServerContainer } from "../../service";
import type { PlaceRefusal } from "../place-search";

/** What players read, in one language or - given `speech.EVERY` - in every one. */
const messages = speech.spoken(written);
const tntRunMessages = speech.spoken(tntRunSaid);
const dropperMessages = speech.spoken(dropperSaid);
const boatMessages = speech.spoken(boatRaceSaid);
const mazeMessages = speech.spoken(netherMazeSaid);
const acidMessages = speech.spoken(acidRainSaid);

/** The event cannot go ahead - too few joined, the structure would not stand -
 *  and ends as called off, with everything undone. */
export class CalledOff extends Error {}

/** What of the loop this needs: the run, which it changes, and the language. */
export interface StageLoop {
    run: EventRun;
    /** Every language: each line is split for its readers on the way out. */
    readonly language: speech.Speech;
    /** Whether the snowball pack is on, once it has been looked at this run. */
    snowballPack?: boolean;
    /** Whether a spleef's players were told its floors are closing in. */
    shrinkTold?: boolean;
    /** How a boat race hands out boats on this server, once looked at. */
    boatWay?: boatRace.BoatWay;
    /** The racers seen on the last tick: one seen again after missing it has
     *  just come back on (`PackRace.rejoined`). */
    present?: Set<string>;
    /** How many top-ups of cobblestone an acid rain has handed out since "Go!". */
    acidTopUps?: number;
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
    /** How this server's version hands a racer a boat (`boat-race.BoatWay`). */
    boatWay(): Promise<boatRace.BoatWay>;
    /** Whose run a kept bag belongs to, for its database copy. */
    readonly stashOwner: stashService.StashOwner;
}

/** How many looks the area gets to load before the site is given up: three
 *  ticks, and the quick look straight after it is held (`stageTick`). */
const LOAD_WAITS = 4;
/** Never built closer to the ground than this, even under a low build limit. */
const LEAST_HEIGHT = 20;
/** How far outside the volume somebody can wander before they count as gone. */
const STRAY = 16;

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
          /** Spleef, and TNT run: floors stacked in the air, the last one standing wins. */
          readonly kind: "spleef" | "tnt-run";
          readonly arena: spleef.Arena;
          readonly boxes: readonly stage.Box[];
          readonly volume: stage.Volume;
          readonly reach: number;
      }
    | {
          readonly kind: "dropper";
          readonly shaft: dropper.Shaft;
          readonly boxes: readonly stage.Box[];
          readonly volume: stage.Volume;
          readonly reach: number;
      }
    | {
          readonly kind: "boat-race";
          readonly track: boatRace.Track;
          readonly boxes: readonly stage.Box[];
          readonly volume: stage.Volume;
          readonly reach: number;
      }
    | {
          readonly kind: "nether-maze";
          readonly maze: netherMaze.Maze;
          readonly boxes: readonly stage.Box[];
          readonly volume: stage.Volume;
          readonly reach: number;
      }
    | {
          readonly kind: "acid-rain";
          readonly acid: acidRain.Acid;
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
            y,
            run.stage?.origin ? run.stage.design : parkour.DESIGN
        );
        return {
            kind: "parkour",
            course,
            boxes: course.boxes,
            volume: course.volume,
            reach: course.reach
        };
    }
    if (run.preset.kind === "boat-race") {
        const track = boatRace.track(
            run.preset.options as catalog.EventOptions<"boat-race">,
            run.id,
            site,
            y,
            run.stage?.origin ? run.stage.design : boatRace.DESIGN
        );
        return {
            kind: "boat-race",
            track,
            boxes: track.boxes,
            volume: track.volume,
            reach: track.reach
        };
    }
    if (run.preset.kind === "nether-maze") {
        const maze = netherMaze.maze(
            run.preset.options as catalog.EventOptions<"nether-maze">,
            run.id,
            site,
            y,
            run.stage?.origin ? run.stage.design : netherMaze.DESIGN
        );
        return {
            kind: "nether-maze",
            maze,
            boxes: maze.boxes,
            volume: maze.volume,
            reach: maze.reach
        };
    }
    if (run.preset.kind === "acid-rain") {
        const acid = acidRain.arena(
            run.preset.options as catalog.EventOptions<"acid-rain">,
            run.id,
            site,
            y
        );
        return {
            kind: "acid-rain",
            acid,
            boxes: acid.boxes,
            volume: acid.volume,
            reach: acid.reach
        };
    }
    if (run.preset.kind === "dropper") {
        const shaft = dropper.shaft(
            run.preset.options as catalog.EventOptions<"dropper">,
            run.id,
            site,
            y
        );
        return {
            kind: "dropper",
            shaft,
            boxes: shaft.boxes,
            volume: shaft.volume,
            reach: shaft.reach
        };
    }
    const floor =
        run.preset.kind === "tnt-run"
            ? tntRun.arena(run.preset.options as catalog.EventOptions<"tnt-run">, site, y)
            : spleef.arena(run.preset.options as catalog.EventOptions<"spleef">, site, y);
    return {
        kind: run.preset.kind === "tnt-run" ? "tnt-run" : "spleef",
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
        // The site chosen, then straight on in the same tick: its area held, a
        // moment for its chunks (`pace.LOAD_PAUSE_MS`), proved empty, built and
        // everybody brought in - and below, the first look at whether they are
        // all there. What has to wait - the site searched, chunks slow to load,
        // somebody not there yet - waits for the next tick as it always did.
        for (let step = 0; step < pace.STEPS_AT_ONCE; step += 1) {
            const hadOrigin = state(loop).origin !== null;
            await raise(loop, server, tools, now, lines);
            if (state(loop).built || hadOrigin || state(loop).origin === null) break;
            await server.sayAll(lines.splice(0, lines.length));
            await pace.pause(pace.LOAD_PAUSE_MS);
        }
        if (!state(loop).built) return null;
    }
    lines.push(stage.PROTECT_INSIDE);
    if (Math.floor(now / 2_000) % 5 === 0) lines.push(stage.FEED_INSIDE);
    const layout = built(loop.run);
    if (!layout) return null;
    // A dropper is played under Slow Falling, given again like Resistance.
    if (layout.kind === "dropper") lines.push(dropper.SLOW_INSIDE);
    // A maze's fire never leaves anybody burning.
    if (layout.kind === "nether-maze") lines.push(netherMaze.COOL_INSIDE);
    lines.push(stage.floatDown(layout.volume, 10), ...commands.hostilesOut(layout.volume));
    // Nothing starts until everybody brought in is there (`arrival`).
    if (holding(loop)) return holdTick(loop, server, tools, layout, heard, now, lines);
    switch (layout.kind) {
        case "parkour":
            return parkourTick(
                loop,
                server,
                tools,
                layout.course,
                layout.volume,
                heard,
                now,
                lines
            );
        case "dropper":
            return packRaceTick(
                loop,
                server,
                tools,
                layout.volume,
                heard,
                now,
                lines,
                dropperRace(loop, server, layout.shaft)
            );
        case "boat-race":
            loop.boatWay ??= await tools.boatWay();
            return packRaceTick(
                loop,
                server,
                tools,
                layout.volume,
                heard,
                now,
                lines,
                boatRaceOf(loop, server, layout.track)
            );
        case "nether-maze":
            return packRaceTick(
                loop,
                server,
                tools,
                layout.volume,
                heard,
                now,
                lines,
                mazeRace(loop, layout.maze)
            );
        case "acid-rain":
            return acidTick(loop, server, tools, layout.acid, layout.volume, heard, now, lines);
        default:
            return spleefTick(loop, server, tools, layout.arena, layout.volume, heard, now, lines);
    }
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
    // A TNT run's floor is taken from under its players by the data pack
    // (`tnt-run.ts`), and a dropper's landings are caught by it (`dropper.ts`),
    // so the pack is put on before anything is built or anybody moved: taking
    // it in pauses the game for a moment, and without it neither can be played.
    if (!origin && needsPack(preset.kind) && loop.snowballPack !== true) {
        loop.snowballPack = await snowballPackService.ensurePack(server).catch((error) => {
            console.warn("polaris: the event pack could not be put on", String(error));
            return false;
        });
        if (!loop.snowballPack) {
            // Said now: a call-off drops whatever this tick had still to say.
            await server.sayAll([
                ...lines.splice(0, lines.length),
                commands.say(
                    messages.tag(language) +
                        (preset.kind === "dropper"
                            ? dropperMessages.cannotPlay(language)
                            : preset.kind === "boat-race"
                              ? boatMessages.cannotPlay(language)
                              : preset.kind === "nether-maze"
                                ? mazeMessages.cannotPlay(language)
                                : preset.kind === "acid-rain"
                                  ? acidMessages.cannotPlay(language)
                                  : tntRunMessages.cannotPlay(language))
                )
            ]);
            throw new CalledOff("Its data pack could not be put on");
        }
    }
    if (!origin) {
        const reach = layoutAt(loop.run, { x: 0, z: 0 }, 0).reach;
        const ground = await tools.findSite(options.place, reach);
        if (!ground) return;
        const { top } = await tools.flavour();
        // As high as asked, or as high as the build limit leaves room for. A
        // dropper's shaft stands on its own pool, a little over the ground.
        const lift = preset.kind === "dropper" ? dropper.LIFT : options.height;
        const least = preset.kind === "dropper" ? dropper.LIFT : LEAST_HEIGHT;
        let y = ground.y + lift;
        const over = layoutAt(loop.run, ground, y).volume.y2 - (top - 1);
        if (over > 0) y -= over;
        if (y - ground.y < least) {
            await tools.giveUpSite(ground, "tooHigh");
            return;
        }
        const area = stage.areaOf(layoutAt(loop.run, ground, y).volume);
        // Written down before the area is held, so whatever ends the event
        // lets go of it.
        change(loop, {
            origin: { x: ground.x, y, z: ground.z },
            design:
                preset.kind === "dropper"
                    ? dropper.DESIGN
                    : preset.kind === "boat-race"
                      ? boatRace.DESIGN
                      : preset.kind === "nether-maze"
                        ? netherMaze.DESIGN
                        : parkour.DESIGN,
            area,
            waits: 0
        });
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
    // Built a paced trip at a time (`pace.buildPacer`), every box counted.
    const counts = await pace.answered(
        server,
        layout.boxes.map((box) => stage.buildLine(box)),
        pace.buildPacer()
    );
    const whole = layout.boxes.every(
        (box, index) => stage.fillCount(counts[index]!) === stage.volumeOf(box)
    );
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
    arrival.open(loop.run.id, Date.now());
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
    for (const said of await pace.answered(
        server,
        probes.map((box) => stage.buildLine(box)),
        pace.buildPacer()
    )) {
        const count = stage.fillCount(said);
        if (count === null) unloaded = true;
        else filled += count;
    }
    const cleared = (
        await pace.answered(
            server,
            probes.map((box) => stage.removeLine(box)),
            pace.teardownPacer()
        )
    ).every((said) => stage.fillCount(said) !== null);
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

/** What a player reads under "Get ready" as they are brought in. */
function readySubtitle(loop: StageLoop, layout: Layout): string {
    const language = loop.language;
    switch (layout.kind) {
        case "parkour":
            return messages.parkourSubtitle(language);
        case "tnt-run":
            return tntRunMessages.readySubtitle(language);
        case "dropper":
            return dropperMessages.readySubtitle(language);
        case "boat-race":
            return boatMessages.readySubtitle(language);
        case "nether-maze":
            return mazeMessages.readySubtitle(language);
        case "acid-rain":
            return acidMessages.readySubtitle(language);
        case "spleef":
            return messages.spleefReadySubtitle(
                spleef.variantFor(
                    loop.run.id,
                    (loop.run.preset.options as catalog.EventOptions<"spleef">).variants
                ),
                language
            );
    }
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
    // empty-handed. Everybody's put away first, then everybody in at once, in
    // one batch: brought in one at a time, between one player's stash and the
    // next, a big server watched its players arrive a few at a time. Whatever
    // somebody picks up meanwhile is caught by the last look below.
    const stashing = await tools.canStash();
    const places =
        layout.kind === "spleef" || layout.kind === "tnt-run"
            ? spleef.spots(layout.arena, fresh.length)
            : layout.kind === "dropper"
              ? // On the lid before "Go!"; a late racer is let go from the top.
                holding(loop)
                  ? dropper.spots(layout.shaft, fresh.length)
                  : fresh.map(() => dropper.spawn(layout.shaft))
              : layout.kind === "boat-race"
                ? // On the grid, before "Go!" or after it; a late racer goes
                  // in after whoever already has a grid spot, not back on the
                  // same one every time (grid spots are a pure function of
                  // index, so a late racer alone always landed on index 0).
                  boatRace
                      .grid(layout.track, current.racers.length + fresh.length)
                      .slice(current.racers.length)
                : layout.kind === "nether-maze"
                  ? // In the starting room; a late racer goes in with the door
                    // already open.
                    netherMaze.spots(layout.maze, fresh.length)
                  : layout.kind === "acid-rain"
                    ? acidRain.spots(layout.acid, fresh.length)
                    : [];
    if (layout.kind === "parkour") await server.sayAll(parkour.SCORES_ADDED);
    if (layout.kind === "dropper") await server.sayAll(dropper.SCORES_ADDED);
    if (layout.kind === "boat-race") await server.sayAll(boatRace.SCORES_ADDED);
    if (layout.kind === "nether-maze") await server.sayAll(netherMaze.SCORES_ADDED);
    if (layout.kind === "acid-rain") await server.sayAll(acidRain.SCORES_ADDED);
    // A late racer in a race already on gets a boat on the spot.
    const way =
        layout.kind === "boat-race" && !holding(loop)
            ? (loop.boatWay ??= await tools.boatWay())
            : null;
    const ready: { index: number; one: stage.Saved }[] = [];
    const stashed = stashing
        ? await stashAll(
              loop,
              server,
              tools,
              fresh.map((one) => one.name),
              false
          )
        : null;
    for (const [index, one] of fresh.entries())
        if (!stashed || stashed[index]) ready.push({ index, one });
    const brought: string[] = [];
    const going: string[] = [];
    for (const { index, one } of ready) {
        const racer = state(loop).racers.find((each) => same(each.name, one.name))!;
        // Back in a boat race already on, after leaving it: from the last gate
        // they passed, with every pass they made - not from nothing, on a clock
        // that kept running while they were away.
        const resumed =
            layout.kind === "boat-race" && !holding(loop) && racer.best > 0 ? racer.best : 0;
        const spot =
            layout.kind === "parkour"
                ? parkour.spotOn(layout.course, racer.checkpoint)
                : resumed > 0 && layout.kind === "boat-race"
                  ? boatRace.resumeSpot(layout.track, resumed)
                  : places[index]!;
        going.push(
            ...stage.admitLines(one.name, spot),
            `title ${one.name} times 5 50 15`,
            `title ${one.name} subtitle ${commands.text(readySubtitle(loop, layout))}`,
            // "Go!" only to a late racer joining a race already on; everybody
            // else waits for the rest, and the countdown.
            `title ${one.name} title ${commands.text(
                (layout.kind === "parkour" ||
                    layout.kind === "dropper" ||
                    layout.kind === "boat-race" ||
                    layout.kind === "nether-maze") &&
                    !holding(loop)
                    ? messages.goTitle(loop.language)
                    : messages.spleefReadyTitle(loop.language)
            )}`,
            // Their checkpoint, once they are on it, for the quick look; a
            // dropper's racer, nowhere yet.
            ...(layout.kind === "parkour" ? parkour.racerScores(one.name, racer.checkpoint) : []),
            ...(layout.kind === "dropper" ? dropper.racerScores(one.name, layout.shaft) : []),
            // A late racer is let go from the top straight away: a fall that
            // may last longer than the server lets anybody be in the air.
            ...(layout.kind === "dropper" && !holding(loop) ? stage.lightFallLines(one.name) : []),
            ...(layout.kind === "tnt-run" ? tntRun.racerLines(one.name) : []),
            ...(layout.kind === "boat-race"
                ? boatRace.racerScores(one.name, resumed, layout.track.gates.length)
                : []),
            ...(way ? boatRace.boatLines(one.name, way, spot.yaw) : []),
            // The maze's corridors kept off minimaps (`radar.ts`).
            ...(layout.kind === "nether-maze"
                ? [
                      ...netherMaze.racerScores(one.name),
                      radar.radarLine(one.name, radar.RADAR_OFF, mazeMessages.radarOff)
                  ]
                : []),
            ...(layout.kind === "acid-rain" ? acidRain.racerScores(one.name) : [])
        );
        brought.push(one.name);
    }
    if (going.length > 0) await server.sayAll(going);
    // Seen in already: not taken for somebody coming back on.
    for (const name of brought) loop.present?.add(name.toLowerCase());
    // And once in, a last look: whatever turned up on them on the way is put
    // away with the rest; anybody it cannot be taken from is sent back out.
    if (!stashing) return brought.length;
    return (await stashAll(loop, server, tools, brought, true)).filter(Boolean).length;
}

/**
 * Each of `names`' own things put away (`stash`) - or, `inside`, what turned up
 * on them on the way in put away with the rest. Answers, for each, whether they
 * are in: somebody whose things cannot all be put away is kept out - told why,
 * sent back where they were if they had been brought in, and handed back
 * whatever was taken.
 *
 * Side by side, their reads and writes sharing trips (`pace.coalescing`): one
 * trip a step for everybody rather than one each. Whoever is kept out is then
 * seen to one at a time, in order, as before.
 */
async function stashAll(
    loop: StageLoop,
    server: ServerContainer,
    tools: StageTools,
    names: readonly string[],
    inside: boolean
): Promise<boolean[]> {
    const shared = pace.coalescing(server);
    const settled = await Promise.allSettled(
        names.map(async (name) => {
            const saved = state(loop).saved.find((one) => same(one.name, name));
            if (!saved) return "out" as const;
            if (!inside && saved.stash) return null;
            return stashService.stashIn(
                shared,
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
        })
    );
    const failed = settled.find((outcome) => outcome.status === "rejected");
    if (failed) throw failed.reason;
    const inOrOut: boolean[] = [];
    for (const [index, name] of names.entries()) {
        const outcome = settled[index]!;
        const result = outcome.status === "fulfilled" ? outcome.value : null;
        if (result === "out") inOrOut.push(false);
        else if (!result?.refused) inOrOut.push(true);
        else inOrOut.push(await keptOut(loop, server, tools, name, result.refused));
    }
    return inOrOut;
}

/** Somebody whose things could not all be put away (`refused`), kept out. */
async function keptOut(
    loop: StageLoop,
    server: ServerContainer,
    tools: StageTools,
    name: string,
    refused: NonNullable<stashService.StashResult["refused"]>
): Promise<boolean> {
    loop.run = {
        ...loop.run,
        keptOut: await stashService.keepOut(server, loop.run.keptOut, name, refused, loop.language)
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
    const after = built(loop.run)?.kind === "nether-maze" ? radarBack : undefined;
    if (
        !(await returnOne(server, saved, (await tools.flavour()).items, loop.language, keep, after))
    )
        return false;
    change(loop, { saved: state(loop).saved.filter((one) => !same(one.name, name)) });
    return true;
}

async function returnOne(
    server: ServerContainer,
    saved: stage.Saved,
    items: stage.Flavour["items"],
    language: speech.Speech,
    keep: (kept: stash.Stash | null) => Promise<void>,
    after?: (name: string) => string[]
): Promise<boolean> {
    const still = await returnAll(server, [saved], items, language, (_, kept) => keep(kept), after);
    return still.length === 0;
}

/** A maze's racer's minimap given back what the server allows, on their way home. */
function radarBack(name: string): string[] {
    return [radar.radarLine(name, radar.RADAR_RESET)];
}

/**
 * Everybody in `saved` sent back where they were, all in the same moment - one
 * trip for every teleport, never one player after another - and then each
 * given back their own things. Answers who is still owed something, with
 * whatever of theirs is still kept.
 */
async function returnAll(
    server: ServerContainer,
    saved: readonly stage.Saved[],
    items: stage.Flavour["items"],
    language: speech.Speech,
    keep: (name: string, kept: stash.Stash | null) => Promise<void> = async () => undefined,
    /** More for each of them once home: what the event switched off for them. */
    after: (name: string) => string[] = () => []
): Promise<stage.Saved[]> {
    if (saved.length === 0) return [];
    // Nothing from here on can make them fall to their death.
    await server.sayAll(saved.flatMap((one) => stage.fallProof(one.name)));
    // Sent home already, by an end that stopped before it gave everything back:
    // not moved again, only given what they are still owed.
    // Everybody's reads and writes below share trips (`pace.coalescing`).
    const shared = pace.coalescing(server);
    const say = (line: string) => shared.say([line]);
    const back = new Set<stage.Saved>();
    const wereBack = await Promise.all(
        saved.map((one) => commands.alreadyBack(say, one.name, stage.IN_ARENA))
    );
    for (const [index, one] of saved.entries()) if (wereBack[index]) back.add(one);
    // Their own gravity too, should that end have stopped before it.
    if (back.size > 0)
        await server.sayAll(
            [...back].flatMap((one) => [...stage.normalFallLines(one.name), ...after(one.name)])
        );
    const going = saved.filter((one) => !back.has(one));
    // The event's items off, then home - everybody at once - then, there,
    // their own game mode.
    if (going.length > 0)
        await server.sayAll(going.flatMap((one) => stage.clearMarked(one.name, items)));
    const answers = await commands.answersOf(server, going.map(stage.returnLine));
    const still: stage.Saved[] = [];
    const home = going.filter((one, index) => {
        if (stage.returned(answers[index]!)) return true;
        still.push(one);
        return false;
    });
    const note = messages.tag(language) + messages.backWhereYouWere(language);
    if (home.length > 0)
        await server.sayAll(
            home.flatMap((one) => [...stage.afterReturnLines(one, items, note), ...after(one.name)])
        );
    // Their own things back only once they are home and down: nothing is given
    // back to a player who could still fall with it. Everybody is home by now,
    // and they are seen to side by side: each one's wait overlaps everybody
    // else's, and their reads and writes share trips.
    const owed = await Promise.allSettled(
        saved.map(async (one): Promise<stage.Saved | null> => {
            if (!back.has(one) && !home.includes(one)) return null;
            let current = one;
            const down = await stashService.settle(shared, one.name, (name) =>
                stage.fallProof(name, 5)
            );
            if (!current.stash) return null;
            if (!down) return current;
            const how = await stashService.giveBack(
                shared,
                one.name,
                current.stash,
                async (kept) => {
                    current = { ...current, stash: kept };
                    await keep(one.name, kept);
                }
            );
            return how !== "done" && how !== "failed" ? current : null;
        })
    );
    let failed: unknown = null;
    for (const outcome of owed) {
        if (outcome.status === "rejected") failed ??= outcome.reason;
        else if (outcome.value) still.push(outcome.value);
    }
    if (failed !== null) throw failed;
    return still;
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

// ------------------------------------------------------------------ the start

/**
 * Everybody brought in, and the start not given yet: the wait for whoever is
 * still on their way (`arrival`). A run already started before this was
 * written down - its clock running - is never held.
 */
function holding(loop: StageLoop): boolean {
    const current = state(loop);
    return (
        current.built &&
        current.goAt === null &&
        loop.run.readyAt === null &&
        current.racers.some((one) => one.outAt === null)
    );
}

/** Whether somebody stands where the start puts them: the parkour's start pad,
 *  the spleef's top floor. */
function inPlace(layout: Layout, at: { x: number; y: number; z: number }): boolean {
    if (layout.kind === "parkour") return parkour.onStart(layout.course, at);
    if (layout.kind === "dropper") return dropper.onLid(layout.shaft, at);
    if (layout.kind === "boat-race") return boatRace.onGrid(layout.track, at);
    if (layout.kind === "nether-maze") return netherMaze.inStart(layout.maze, at);
    if (layout.kind === "acid-rain") return acidRain.inside(layout.acid, at);
    const { center, size, floor } = layout.arena;
    return (
        at.y >= floor + 0.5 &&
        at.y <= floor + 3 &&
        Math.abs(at.x - (center.x + 0.5)) <= size + 1 &&
        Math.abs(at.z - (center.z + 0.5)) <= size + 1
    );
}

/**
 * One tick of the wait before the start: nobody hurt (the tick's own
 * protection), nothing counted, nobody a step ahead - a racer off the start
 * pad is put back on it by the quick look (`parkour.holdLines`). Joins and
 * leaves are taken as before the start. Once everybody is there, or the wait
 * runs out: the countdown, everybody put back on their own start spot, and
 * "Go!" - a parkour's clock started for every racer at once, a spleef's
 * shovels handed out by its own tick straight after.
 */
async function holdTick(
    loop: StageLoop,
    server: ServerContainer,
    tools: StageTools,
    layout: Layout,
    heard: readonly { name: string; call: stage.Call }[],
    now: number,
    lines: string[]
): Promise<string | null> {
    const language = loop.language;
    let dirty = false;
    for (const { name, call } of heard) {
        const racer = state(loop).racers.find((one) => same(one.name, name));
        const inside = racer !== undefined && racer.outAt === null;
        if (call === "join" && !inside) {
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
    const here = new Map(where.map((one) => [one.name.toLowerCase(), one]));
    // Gone from it by their own doing once in - another world, far off: out,
    // and home. Whoever has not been seen in yet is waited for, not sent off.
    for (const racer of state(loop).racers) {
        const at = here.get(racer.name.toLowerCase());
        if (
            racer.outAt !== null ||
            !at ||
            !arrival.hasArrived(loop.run.id, racer.name) ||
            !strayed(at, dimensions.get(at.name), layout.volume)
        )
            continue;
        await sendHome(loop, server, tools, racer.name);
        markOut(loop, racer.name, now, 0);
        dirty = true;
    }
    const names = state(loop)
        .racers.filter((one) => one.outAt === null)
        .map((one) => one.name);
    if (names.length === 0) {
        if (dirty) await tools.persist();
        // Everybody left before the start: nobody to play it.
        lines.push(commands.say(messages.tag(language) + messages.everybodyDone(language)));
        return "Everybody dropped out before the start";
    }
    const seen = arrival.look(loop.run.id, now, names, (name) => {
        const at = here.get(name.toLowerCase());
        return at !== undefined && inPlace(layout, at);
    });
    if (!seen.start) {
        if (dirty) await tools.persist();
        lines.push(arrival.waitingLine(`@a[tag=${stage.IN_ARENA}]`, seen, language));
        return null;
    }
    arrival.forget(loop.run.id);
    // What this tick has to say first, then the countdown on time.
    await server.sayAll(lines.splice(0, lines.length));
    await arrival.countdown((out) => server.sayAll(out), `@a[tag=${stage.IN_ARENA}]`, language);
    const go = Date.now();
    const racing = state(loop).racers.filter((one) => one.outAt === null);
    if (layout.kind === "parkour") {
        const start = parkour.spotOn(layout.course, 0);
        for (const racer of racing)
            lines.push(
                stage.moveLine(racer.name, start),
                ...parkour.racerScores(racer.name, 0),
                `title ${racer.name} times 5 40 10`,
                `title ${racer.name} subtitle ${commands.text(messages.parkourSubtitle(language))}`,
                `title ${racer.name} title ${commands.text(messages.goTitle(language))}`,
                soundFor(racer.name, commands.SOUNDS.start)
            );
        // Everybody's time counts from this moment, whoever was in first.
        change(loop, {
            racers: state(loop).racers.map((one) =>
                one.outAt === null ? { ...one, since: go, best: 0, checkpoint: 0 } : one
            )
        });
    } else if (layout.kind === "boat-race") {
        // Everybody on their own spot of the grid, in a boat, the pack counting
        // gates - all of it said before the start is written down, so the
        // quick look never finds a racer between their spot and their boat.
        const way = (loop.boatWay ??= await tools.boatWay());
        const places = boatRace.grid(layout.track, racing.length);
        const go: string[] = [...boatRace.SCORES_ADDED];
        racing.forEach((racer, index) =>
            go.push(
                stage.moveLine(racer.name, places[index]!),
                ...boatRace.racerScores(racer.name),
                ...boatRace.boatLines(racer.name, way, places[index]!.yaw),
                `title ${racer.name} times 5 40 10`,
                `title ${racer.name} subtitle ${commands.text(boatMessages.goSubtitle(layout.track.laps, language))}`,
                `title ${racer.name} title ${commands.text(messages.goTitle(language))}`,
                soundFor(racer.name, commands.SOUNDS.start)
            )
        );
        await server.sayAll([...go, ...boatRace.armLines(layout.track)]);
        const started = Date.now();
        change(loop, {
            racers: state(loop).racers.map((one) =>
                one.outAt === null ? { ...one, since: started, best: 0 } : one
            )
        });
    } else if (layout.kind === "dropper") {
        // Everybody over the middle, the lid gone, the pack watching for a
        // landing: they all fall from the one spot the shaft was laid out from.
        const spawn = dropper.spawn(layout.shaft);
        for (const racer of racing)
            lines.push(
                stage.moveLine(racer.name, spawn),
                ...dropper.racerScores(racer.name, layout.shaft),
                // Falls of more than four seconds without being kicked for
                // flying (`stage.lightFallLines`); taken off on the way home.
                ...stage.lightFallLines(racer.name),
                `title ${racer.name} times 5 40 10`,
                `title ${racer.name} subtitle ${commands.text(dropperMessages.goSubtitle(language))}`,
                `title ${racer.name} title ${commands.text(messages.goTitle(language))}`,
                soundFor(racer.name, commands.SOUNDS.start)
            );
        lines.push(dropper.lidGone(layout.shaft), ...dropper.armLines(layout.shaft));
        change(loop, {
            racers: state(loop).racers.map((one) =>
                one.outAt === null ? { ...one, since: go, best: 0 } : one
            )
        });
    } else if (layout.kind === "nether-maze") {
        // Everybody back on their own spot of the starting room, the door
        // gone, the pack watching the hazards and the middle room.
        const places = netherMaze.spots(layout.maze, racing.length);
        racing.forEach((racer, index) =>
            lines.push(
                stage.moveLine(racer.name, places[index]!),
                ...netherMaze.racerScores(racer.name),
                `title ${racer.name} times 5 40 10`,
                `title ${racer.name} subtitle ${commands.text(mazeMessages.goSubtitle(language))}`,
                `title ${racer.name} title ${commands.text(messages.goTitle(language))}`,
                soundFor(racer.name, commands.SOUNDS.start)
            )
        );
        lines.push(netherMaze.doorGone(layout.maze), ...netherMaze.armLines(layout.maze));
        change(loop, {
            racers: state(loop).racers.map((one) =>
                one.outAt === null ? { ...one, since: go, best: 0 } : one
            )
        });
    } else if (layout.kind === "acid-rain") {
        const places = acidRain.spots(layout.acid, racing.length);
        racing.forEach((racer, index) => lines.push(stage.moveLine(racer.name, places[index]!)));
    } else {
        const places = spleef.spots(layout.arena, racing.length);
        racing.forEach((racer, index) => lines.push(stage.moveLine(racer.name, places[index]!)));
    }
    lines.push(...arrival.startedWithoutLines(seen, language));
    // The start, written down: a spleef's tick hands out the shovels from it.
    change(loop, { goAt: now });
    await tools.persist();
    if (layout.kind === "spleef" || layout.kind === "tnt-run")
        return spleefTick(loop, server, tools, layout.arena, layout.volume, [], now, lines);
    if (layout.kind === "acid-rain")
        return acidTick(loop, server, tools, layout.acid, layout.volume, [], now, lines);
    return null;
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

    lines.push(...parkour.blinkLines(course, now));
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
        // Anything it missed, from where they stand. The platform right after
        // the next checkpoint is reached only from it, so standing there is
        // having crossed it between two looks. Anything further got round part
        // of the course (an ender pearl, a push) and goes back to their own.
        const on = parkour.platformUnder(course, at);
        const ahead = parkour.nextCheckpoint(course, next.checkpoint);
        if (on !== null && on > ahead + 1 && next.finishedAt === null) {
            lines.push(
                stage.moveLine(racer.name, parkour.spotOn(course, next.checkpoint)),
                tell(racer.name, messages.tag(language) + messages.noShortcut(language))
            );
            continue;
        }
        let sounded = next.finishedAt !== null;
        if (on !== null && on > next.best) next = { ...next, best: on };
        const crossed = on !== null && on > ahead ? ahead : on;
        if (crossed !== null && crossed > next.checkpoint) {
            const role = course.platforms[crossed]!.role;
            if (role === "checkpoint" || role === "finish") {
                next = { ...next, checkpoint: crossed };
                const reached = parkour.checkpointsBy(course, crossed);
                lines.push(
                    `title ${racer.name} times 5 30 10`,
                    `title ${racer.name} subtitle ${commands.text(" ")}`,
                    `title ${racer.name} title ${commands.text(messages.checkpointTitle(reached, checkpoints, language))}`,
                    soundFor(racer.name, commands.SOUNDS.tick),
                    `scoreboard players set ${racer.name} ${parkour.CHECKPOINT_SCORE} ${crossed}`
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
 * The racers in the order they finished by the game's own tick, the rest after
 * in their own order: two who finish within one look are told their places
 * the way they reached the line, not the way they joined.
 */
export function byFinish<T extends { name: string }>(
    racers: readonly T[],
    finished: ReadonlyMap<string, number>
): T[] {
    const tick = (one: T) => finished.get(one.name.toLowerCase()) ?? Number.POSITIVE_INFINITY;
    return [...racers].sort((a, b) => tick(a) - tick(b));
}

/**
 * The quick look at a parkour race, run far oftener than the tick: whoever fell
 * is sent back to their checkpoint, and whoever stepped onto a checkpoint or
 * the finish is told and has it marked - with selectors over the checkpoints the
 * game keeps (`parkour.CHECKPOINT_SCORE`), so it reads nothing and is one batch
 * whatever the number of racers. The tick picks up what it marked. Nothing
 * while no racer is still going. In a dropper, only the word to whoever the
 * data pack sent back up: the pack itself is quicker than any look.
 */
export function quickLines(loop: StageLoop): string[] {
    const layout = built(loop.run);
    if (!layout || !state(loop).built) return [];
    // A dropper: whoever the pack sent back up is told so.
    if (layout.kind === "dropper")
        return holding(loop)
            ? []
            : dropper.backLines(
                  commands.text(
                      messages.tag(loop.language) + dropperMessages.backToTop(loop.language)
                  )
              );
    // A maze: whoever the pack sent back out of a hazard is told so.
    if (layout.kind === "nether-maze")
        return holding(loop)
            ? []
            : netherMaze.backLines(
                  commands.text(messages.tag(loop.language) + mazeMessages.burned(loop.language))
              );
    // A boat race: whoever fell, cut a corner or left their boat, put back.
    if (layout.kind === "boat-race") {
        if (holding(loop) || !loop.boatWay) return [];
        const language = loop.language;
        const told = (line: string) => commands.text(messages.tag(language) + line);
        return boatRace.quickLines(layout.track, loop.boatWay, {
            fell: told(boatMessages.fell(language)),
            cut: told(boatMessages.cut(language)),
            lost: told(boatMessages.lost(language))
        });
    }
    if (layout.kind !== "parkour") return [];
    // Before the start: nobody off the start pad.
    if (holding(loop)) return parkour.holdLines(layout.course);
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

// ------------------------------------------------------------------ dropper

/** The kinds the events data pack plays a part of (`snowball-pack.ts`). */
function needsPack(kind: catalog.EventKind): boolean {
    return (
        kind === "tnt-run" ||
        kind === "dropper" ||
        kind === "boat-race" ||
        kind === "nether-maze" ||
        kind === "acid-rain"
    );
}

/** Whether an event can need the events data pack when it runs: a kind
 *  played by it, or a spleef that can draw its snowballs. */
export function usesPack(preset: catalog.EventPreset): boolean {
    if (needsPack(preset.kind)) return true;
    if (preset.kind !== "spleef") return false;
    const { variants } = preset.options as catalog.EventOptions<"spleef">;
    return variants.includes("snowballs");
}

/**
 * What one race played by the pack reads and says each tick: how far each racer
 * has got (from what the pack noted and from where they stand), the title at
 * their finish, and the bar while they race.
 */
interface PackRace {
    /** Read once a tick: each racer's progress so far, or undefined. */
    progress(): Promise<
        (racer: stage.Racer, at: { x: number; y: number; z: number }) => number | undefined
    >;
    /** Progress at the finish. */
    readonly whole: number;
    /** The title a finish is shown under. */
    readonly finishTitle: string;
    /** More for a racer the tick they finish (their own gravity back). */
    finished?(name: string): string[];
    bar(racer: stage.Racer, at: { x: number; y: number; z: number }): string;
    /** For a racer back on after being away: what their game forgot. */
    rejoined?(name: string): string[];
    /** The finish ticks, as the pack has them. */
    readonly readFinished: string;
    /** Nothing left for the pack to watch. */
    readonly stop: readonly string[];
}

/**
 * One tick of a race the pack plays a part of - a dropper, a boat race, a
 * maze. The pack does the play (sends a racer back, counts gates, notes each
 * finish to the tick) and this reads what it noted: each racer's progress, their
 * finish, and who strayed. A late joiner starts from the start, their time
 * counted from then.
 */
async function packRaceTick(
    loop: StageLoop,
    server: ServerContainer,
    tools: StageTools,
    volume: stage.Volume,
    heard: readonly { name: string; call: stage.Call }[],
    now: number,
    lines: string[],
    race: PackRace
): Promise<string | null> {
    const language = loop.language;
    let dirty = false;
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
    const progress = await race.progress();
    const finished = lowered(commands.readScores(await server.say([race.readFinished])));
    // The game's own tick, asked only when somebody has finished.
    let gameNow: number | null | undefined;
    // Who is back on since the last tick; after a restart, nobody is.
    const before = loop.present;
    loop.present = new Set(where.map((one) => one.name.toLowerCase()));
    for (const racer of byFinish(state(loop).racers, finished)) {
        if (racer.outAt !== null) continue;
        const at = where.find((one) => same(one.name, racer.name));
        if (!at) continue;
        if (before && !before.has(racer.name.toLowerCase()) && race.rejoined)
            lines.push(...race.rejoined(racer.name));
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
        let next = racer;
        const got = progress(racer, at);
        if (got !== undefined && got > next.best)
            next = { ...next, best: Math.min(got, race.whole) };
        const tick = finished.get(racer.name.toLowerCase());
        if (tick !== undefined) {
            if (gameNow === undefined)
                gameNow = commands.readDaytime(await server.say([parkour.READ_GAME_TIME]));
            const when =
                gameNow === null
                    ? now
                    : Math.max(racer.since, Math.min(now, now - Math.max(0, gameNow - tick) * 50));
            next = { ...next, best: race.whole, finishedAt: when };
            lines.push(...(race.finished?.(racer.name) ?? []));
            const place = state(loop).racers.filter((one) => one.finishedAt !== null).length + 1;
            lines.push(
                commands.say(
                    messages.tag(language) +
                        messages.finishedLine(
                            racer.name,
                            messages.clock((when - racer.since) / 1000),
                            place,
                            language
                        )
                ),
                `title ${racer.name} times 5 40 10`,
                `title ${racer.name} subtitle ${commands.text(" ")}`,
                `title ${racer.name} title ${commands.text(race.finishTitle)}`,
                soundFor(racer.name, commands.SOUNDS.win)
            );
        } else lines.push(commands.actionbarFor(racer.name, race.bar(next, at)));
        if (next !== racer) {
            change(loop, {
                racers: state(loop).racers.map((one) => (same(one.name, racer.name) ? next : one))
            });
            lines.push(commands.setScore(racer.name, next.best));
            dirty = true;
        }
    }
    if (dirty) await tools.persist();
    const racers = state(loop).racers;
    if (racers.length > 0 && racers.every((one) => one.finishedAt !== null || one.outAt !== null)) {
        lines.push(...race.stop);
        lines.push(commands.say(messages.tag(language) + messages.everybodyDone(language)));
        return "Everybody finished or dropped out";
    }
    return null;
}

/** A dropper: the pack sends a racer who lands on a floor back to the top and
 *  notes how low each has been; progress is the deepest floor. */
function dropperRace(loop: StageLoop, server: ServerContainer, shaft: dropper.Shaft): PackRace {
    const language = loop.language;
    const levels = shaft.floors.length;
    return {
        async progress() {
            const lowest = lowered(commands.readScores(await server.say([dropper.READ_LOWEST])));
            // The deepest they have been: from the pack, and from where they are.
            return (racer, at) => {
                const low = lowest.get(racer.name.toLowerCase());
                return Math.max(
                    dropper.floorsPassed(shaft, low === undefined ? at.y : dropper.lowestOf(low)),
                    dropper.floorsPassed(shaft, at.y)
                );
            };
        },
        whole: levels,
        finishTitle: messages.checkpointTitle(levels, levels, language),
        // In the water: their own gravity back, so a jump is a jump.
        finished: (name) => stage.normalFallLines(name),
        bar: (racer, at) =>
            dropperMessages.bar(
                Math.min(levels, dropper.floorsPassed(shaft, at.y) + 1),
                racer.best,
                levels,
                language
            ),
        readFinished: dropper.READ_FINISHED,
        stop: dropper.stopLines(shaft.boxes)
    };
}

/** A boat race: the pack counts the gates; progress is the gates passed. */
function boatRaceOf(loop: StageLoop, server: ServerContainer, track: boatRace.Track): PackRace {
    const language = loop.language;
    const gates = track.gates.length;
    return {
        async progress() {
            const passed = lowered(commands.readScores(await server.say([boatRace.READ_PASSED])));
            return (racer) => passed.get(racer.name.toLowerCase());
        },
        whole: track.laps * gates + 1,
        finishTitle: messages.checkpointTitle(gates, gates, language),
        bar: (racer) => {
            const progress = boatRace.progressOf(track, racer.best);
            return boatMessages.bar(progress.lap, track.laps, progress.gate, gates, language);
        },
        readFinished: boatRace.READ_FINISHED,
        stop: boatRace.stopLines(track.boxes)
    };
}

/** A maze: the pack sends the burned back and notes the finish; progress is
 *  how many rooms closer to the middle they have been. */
function mazeRace(loop: StageLoop, built: netherMaze.Maze): PackRace {
    const language = loop.language;
    const rooms = netherMaze.roomsToGo(built);
    return {
        async progress() {
            return (_racer, at) => netherMaze.progressAt(built, at) ?? undefined;
        },
        whole: rooms,
        finishTitle: messages.checkpointTitle(rooms, rooms, language),
        bar: (racer, at) =>
            mazeMessages.bar(
                Math.max(racer.best, netherMaze.progressAt(built, at) ?? 0),
                rooms,
                language
            ),
        // A minimap forgets the fair-play code on a fresh join.
        rejoined: (name) => [radar.radarLine(name, radar.RADAR_OFF, mazeMessages.radarOff)],
        readFinished: netherMaze.READ_FINISHED,
        stop: netherMaze.stopLines(built.boxes)
    };
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
    // A TNT run plays as a spleef with no tool, whose floor the data pack takes
    // from under its players (`tnt-run.ts`).
    const tnt = loop.run.preset.kind === "tnt-run";
    const variant = tnt
        ? null
        : spleef.variantFor(
              loop.run.id,
              (loop.run.preset.options as catalog.EventOptions<"spleef">).variants
          );
    // Snowballs break the floor, and the decay game takes it, through a data
    // pack put on while everybody is still getting ready: taking it in pauses
    // the game for a moment.
    const packed = variant === "snowballs" || variant === "decay";
    if (!current.armed && packed && loop.snowballPack === undefined) {
        loop.snowballPack = await snowballPackService.ensurePack(server).catch((error) => {
            console.warn("polaris: the snowball pack could not be put on", String(error));
            return false;
        });
        if (!loop.snowballPack)
            console.warn("polaris: the snowball pack is not on", server.installedAppId);
    }
    if (!current.armed && current.goAt !== null && now >= current.goAt) {
        const { items } = await tools.flavour();
        // Red snow - the decay game's, and the edge about to go when the floors
        // close in - is the arena's too: written down before any is made, so
        // whatever ends it takes it out with the rest.
        if (variant) change(loop, { boxes: [...current.boxes, ...spleef.warnBoxes(floor)] });
        for (const racer of current.racers) {
            if (racer.outAt !== null) continue;
            if (variant === "shovel") await handShovel(server, tools, racer.name, items);
            if (variant === "snowballs")
                lines.push(...stage.markedSnowballs(racer.name, items, spleef.SNOWBALLS));
            lines.push(
                `title ${racer.name} subtitle ${commands.text(" ")}`,
                `title ${racer.name} title ${commands.text(variant ? messages.spleefGo(variant, language) : tntRunMessages.goTitle(language))}`,
                soundFor(racer.name, commands.SOUNDS.start)
            );
        }
        if (variant === "snowballs") lines.push(...snowballPack.armLines(floor));
        if (variant === "decay" && loop.snowballPack)
            lines.push(...snowballPack.armLines(floor, true));
        if (tnt) lines.push(...tntRun.armLines(floor));
        change(loop, { armed: true });
        dirty = true;
    } else if (current.armed && tnt) {
        // A primed block taken out over RCON too, should the pack miss one.
        lines.push(tntRun.primedOut(volume));
    } else if (current.armed && variant === "decay" && loop.snowballPack !== true) {
        // No pack: the snow is taken on each look instead, slower.
        const rings = current.goAt === null ? 0 : spleef.shrunk(now - current.goAt);
        lines.push(...spleef.decayLines(floor, stage.IN_ARENA, rings));
    } else if (current.armed && variant === "snowballs" && Math.floor(now / 1000) % 10 < 2) {
        // Topped up every ten seconds or so: nobody runs out for long.
        const { items } = await tools.flavour();
        for (const racer of current.racers)
            if (racer.outAt === null)
                lines.push(...stage.markedSnowballs(racer.name, items, spleef.SNOWBALLS));
    }

    // Nobody waits the others out: everybody glows, and after a while the
    // floors close in.
    if (variant && state(loop).armed && current.goAt !== null) {
        lines.push(spleef.GLOW);
        const rings = spleef.shrunk(now - current.goAt);
        if (rings > 0 && !loop.shrinkTold) {
            loop.shrinkTold = true;
            lines.push(commands.say(messages.tag(language) + messages.spleefShrinking(language)));
            for (const racer of state(loop).racers)
                if (racer.outAt === null)
                    lines.push(
                        `title ${racer.name} subtitle ${commands.text(" ")}`,
                        `title ${racer.name} title ${commands.text(messages.spleefShrinkingTitle(language))}`
                    );
        }
        lines.push(...spleef.shrinkLines(floor, rings));
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
        // player already out, and one for taking part. A TNT run's pack notes
        // the tick each racer fell, which tells those of one look apart - and
        // the last two, when only one of them fell last (`tntRun.fallOrder`).
        const othersStanding = state(loop).racers.filter(
            (one) => one.outAt === null && !out.some((name) => same(name, one.name))
        ).length;
        const order =
            tnt && out.length > 1
                ? tntRun.fallOrder(
                      out,
                      lowered(commands.readScores(await server.say([tntRun.READ_FELL]))),
                      othersStanding
                  )
                : { groups: [out], survivor: null };
        for (const group of order.groups) {
            const points = state(loop).racers.filter((one) => one.outAt !== null).length + 1;
            for (const name of group) markOut(loop, name, now, points);
        }
        out.splice(0, out.length, ...order.groups.flat());
        const left = state(loop).racers.filter((one) => one.outAt === null).length;
        for (const name of out) {
            await sendHome(loop, server, tools, name);
            lines.push(
                commands.say(messages.tag(language) + messages.spleefOut(name, left, language)),
                `title ${name} subtitle ${commands.text(" ")}`,
                `title ${name} title ${commands.text(messages.spleefOutTitle(language))}`,
                ...(variant ? [`effect clear ${name} minecraft:glowing`] : [])
            );
        }
        dirty = true;
    }

    const standing = state(loop).racers.filter((one) => one.outAt === null);
    for (const racer of standing) {
        const at = where.find((one) => same(one.name, racer.name));
        lines.push(
            commands.actionbarFor(
                racer.name,
                !state(loop).armed
                    ? messages.spleefReadyTitle(language)
                    : variant
                      ? messages.spleefBar(standing.length, variant, language)
                      : tntRunMessages.bar(
                            standing.length,
                            at ? tntRun.floorOf(floor, at.y) : 1,
                            floor.floors.length,
                            language
                        )
            )
        );
    }
    if (dirty) await tools.persist();
    if (!state(loop).armed || standing.length > 1) return null;
    const winner = standing[0];
    if (packed) lines.push(...snowballPack.stopLines(floor.boxes));
    if (variant) lines.push("effect clear @a[tag=pe_in] minecraft:glowing");
    if (tnt) lines.push(...tntRun.stopLines(floor.boxes));
    if (!winner) {
        lines.push(commands.say(messages.tag(language) + messages.nobodyStanding(language)));
        return "Nobody was left standing";
    }
    lines.push(commands.say(messages.tag(language) + messages.lastStanding(winner.name, language)));
    return `${winner.name} was the last one standing`;
}

// ------------------------------------------------------------------ acid rain

/**
 * One tick of an acid rain: at "Go!" the rain switched on and the cobblestone
 * handed out, a top-up every while after, the rain eating at the shelters, and
 * whoever's acid is full, who left or who strayed, out - in the order they went,
 * as a spleef's players. The last one left wins; at the end of the time, those
 * still in are ranked by how dry they stayed (`results`).
 */
async function acidTick(
    loop: StageLoop,
    server: ServerContainer,
    tools: StageTools,
    acid: acidRain.Acid,
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
        // Whatever players place and whatever the rain leaves of it is the
        // arena's too: written down before the first block is handed out.
        change(loop, { boxes: [...current.boxes, ...acidRain.sweepBoxes(acid)] });
        for (const racer of current.racers) {
            if (racer.outAt !== null) continue;
            lines.push(
                acidRain.cobblestoneLine(racer.name, items, acidRain.START_BLOCKS),
                `title ${racer.name} subtitle ${commands.text(acidMessages.goSubtitle(language))}`,
                `title ${racer.name} title ${commands.text(acidMessages.goTitle(language))}`,
                soundFor(racer.name, commands.SOUNDS.start)
            );
        }
        lines.push(...acidRain.armLines(acid));
        loop.acidTopUps = 0;
        change(loop, { armed: true });
        dirty = true;
    } else if (current.armed && current.goAt !== null) {
        // More cobblestone every while: a shelter can always be patched.
        const due = Math.floor((now - current.goAt) / acidRain.TOP_UP_MS);
        loop.acidTopUps ??= due;
        if (due > loop.acidTopUps) {
            loop.acidTopUps = due;
            const { items } = await tools.flavour();
            for (const racer of current.racers)
                if (racer.outAt === null)
                    lines.push(
                        acidRain.cobblestoneLine(racer.name, items, acidRain.TOP_UP_BLOCKS),
                        tell(
                            racer.name,
                            messages.tag(language) +
                                acidMessages.topUp(acidRain.TOP_UP_BLOCKS, language)
                        )
                    );
        }
        lines.push(...acidRain.dripLines(acid));
    }

    // Everybody's acid as the pack has it: kept as how dry they stayed, for
    // the end of the time.
    const acidOf = state(loop).armed
        ? lowered(commands.readScores(await server.say([acidRain.READ_ACID])))
        : new Map<string, number>();
    change(loop, {
        racers: state(loop).racers.map((one) => {
            const taken = acidOf.get(one.name.toLowerCase());
            if (one.outAt !== null || taken === undefined) return one;
            const dry = acidRain.dryOf(taken);
            if (dry !== one.best) dirty = true;
            return dry === one.best ? one : { ...one, best: dry };
        })
    });

    const out: string[] = [];
    const soaked = new Set<string>();
    for (const racer of state(loop).racers) {
        if (racer.outAt !== null) continue;
        const at = where.find((one) => same(one.name, racer.name));
        const taken = acidOf.get(racer.name.toLowerCase()) ?? 0;
        if (taken >= acidRain.ACID_MAX) soaked.add(racer.name);
        if (
            leaving.has(racer.name.toLowerCase()) ||
            !at ||
            strayed(at, dimensions.get(at.name), volume) ||
            taken >= acidRain.ACID_MAX
        )
            out.push(racer.name);
    }
    if (out.length > 0) {
        // Everybody out on the same look shares the place, as in a spleef.
        const points = state(loop).racers.filter((one) => one.outAt !== null).length + 1;
        for (const name of out) markOut(loop, name, now, points);
        const left = state(loop).racers.filter((one) => one.outAt === null).length;
        for (const name of out) {
            await sendHome(loop, server, tools, name);
            lines.push(
                commands.say(
                    messages.tag(language) +
                        (soaked.has(name)
                            ? acidMessages.dissolved(name, left, language)
                            : messages.spleefOut(name, left, language))
                ),
                `title ${name} subtitle ${commands.text(" ")}`,
                `title ${name} title ${commands.text(messages.spleefOutTitle(language))}`,
                ...acidRain.racerOutLines(name)
            );
        }
        dirty = true;
    }

    const standing = state(loop).racers.filter((one) => one.outAt === null);
    for (const racer of standing)
        lines.push(
            commands.actionbarFor(
                racer.name,
                !state(loop).armed
                    ? messages.spleefReadyTitle(language)
                    : acidMessages.bar(
                          acidRain.gauge(acidOf.get(racer.name.toLowerCase()) ?? 0),
                          standing.length,
                          language
                      )
            )
        );
    if (dirty) await tools.persist();
    if (!state(loop).armed || standing.length > 1) return null;
    lines.push(...acidRain.stopLines(acid.boxes));
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
        const here = saved.filter((one) => online.has(one.name.toLowerCase()));
        // A maze's racers' minimaps given back too, whenever they come home.
        const after = netherMaze.isMaze(leftover.boxes) ? radarBack : undefined;
        const owed = await returnAll(server, here, flavour.items, language, undefined, after);
        // Kept in the order they were, offline or not.
        saved = saved.flatMap((one) =>
            !here.includes(one) ? [one] : owed.filter((each) => each.name === one.name)
        );
    }
    let boxes = leftover.boxes;
    let area = leftover.area;
    if (boxes.length > 0) {
        // Snowballs stop breaking a spleef floor, and a TNT run's fuses go out,
        // before it goes: nothing for any other arena, or for a game that
        // already ended.
        const stop = [
            ...snowballPack.stopLines(boxes),
            ...tntRun.stopLines(boxes),
            ...dropper.stopLines(boxes),
            ...boatRace.stopLines(boxes),
            ...netherMaze.stopLines(boxes),
            ...acidRain.stopLines(boxes)
        ];
        if (area || stop.length > 0)
            await server.sayAll([...(area ? [stage.holdArea(area)] : []), ...stop]);
        // Whatever is still standing on it - a pet, a mob - floats down
        // rather than falls when it goes.
        const bounds = stage.boundsOf(boxes);
        if (bounds)
            await server.sayAll([
                stage.floatDown(bounds, 60),
                ...stage.fallProofOver(bounds),
                // A boat race's boats - summoned or put down - go with its track.
                ...(boatRace.isTrack(boxes) ? boatRace.boatsGone(bounds) : [])
            ]);
        // Latest first, and nothing after a box that would not come out: what
        // is built later can rest on - or, a dropper's water, be held in by -
        // what was built before it, so nothing goes before what it needs.
        let standing = boxes.length;
        const latestFirst = [...boxes].reverse();
        // Taken out several to a trip only once every chunk under it is seen
        // in (`pace.allLoaded`): in one trip, a box that would not come out
        // could not stop the ones after it. Otherwise one at a time, as ever.
        if (bounds && (await pace.allLoaded(server, bounds))) {
            const said = await pace.answered(
                server,
                latestFirst.map((box) => stage.removeLine(box)),
                pace.teardownPacer()
            );
            for (const answer of said) {
                if (stage.fillCount(answer) === null) break;
                standing -= 1;
            }
        } else
            for (const box of latestFirst) {
                if (stage.fillCount(await server.say([stage.removeLine(box)])) === null) break;
                standing -= 1;
            }
        boxes = boxes.slice(0, standing);
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
        if (
            run.preset.kind === "parkour" ||
            run.preset.kind === "dropper" ||
            run.preset.kind === "boat-race" ||
            run.preset.kind === "nether-maze"
        ) {
            // A time to the finish, then how far they got: jumps, floors, gates or rooms.
            scores.set(
                one.name,
                one.finishedAt !== null
                    ? parkour.finishScore((one.finishedAt - one.since) / 1000)
                    : one.best
            );
        } else if (run.preset.kind === "acid-rain") {
            // The order they went out in, then - among those still in at the
            // end - who stayed driest.
            scores.set(
                one.name,
                acidRain.scoreOf(
                    one.outAt === null ? racers.length : one.points,
                    one.outAt === null ? one.best : null
                )
            );
        } else {
            scores.set(one.name, one.outAt === null ? racers.length : one.points);
        }
    }
    return { scores, took: racers.map((one) => one.name) };
}

/** The standings for the screen while it runs: jumps made, or points so far. */
export function standings(run: EventRun): { name: string; score: number }[] {
    const course =
        run.preset.kind === "parkour" ||
        run.preset.kind === "boat-race" ||
        run.preset.kind === "nether-maze"
            ? built(run)
            : null;
    // A finish counts as every jump, floor or gate there is.
    const jumps =
        course?.kind === "parkour"
            ? course.course.platforms.length - 1
            : course?.kind === "boat-race"
              ? course.track.laps * course.track.gates.length + 1
              : course?.kind === "nether-maze"
                ? netherMaze.roomsToGo(course.maze)
                : run.preset.kind === "dropper"
                  ? (run.preset.options as catalog.EventOptions<"dropper">).levels
                  : 0;
    return (run.stage?.racers ?? [])
        .map((one) => ({
            name: one.name,
            score:
                run.preset.kind === "parkour" ||
                run.preset.kind === "dropper" ||
                run.preset.kind === "boat-race" ||
                run.preset.kind === "nether-maze"
                    ? one.finishedAt !== null
                        ? jumps
                        : one.best
                    : run.preset.kind === "acid-rain"
                      ? acidRain.scoreOf(
                            one.outAt === null ? (run.stage?.racers.length ?? 0) : one.points,
                            one.outAt === null ? one.best : null
                        )
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
    if (kind === "boat-race") {
        if (parkour.isFinish(score)) return messages.clock(parkour.FINISH_BASE - score);
        return speech.pickIn(
            {
                en: `${score} ${score === 1 ? "gate" : "gates"}`,
                es: `${score} ${score === 1 ? "puerta" : "puertas"}`
            },
            language
        );
    }
    if (kind === "nether-maze") {
        if (parkour.isFinish(score)) return messages.clock(parkour.FINISH_BASE - score);
        return speech.pickIn(
            {
                en: `${score} ${score === 1 ? "room" : "rooms"} closer`,
                es: `${score} ${score === 1 ? "sala" : "salas"} más cerca`
            },
            language
        );
    }
    if (kind === "dropper") {
        if (parkour.isFinish(score)) return messages.clock(parkour.FINISH_BASE - score);
        return speech.pickIn(
            {
                en: `${score} ${score === 1 ? "floor" : "floors"}`,
                es: `${score} ${score === 1 ? "piso" : "pisos"}`
            },
            language
        );
    }
    if (kind === "acid-rain") {
        const { place, dry } = acidRain.scoreParts(score);
        return speech.pickIn(
            dry > 0
                ? {
                      en: `${place} ${place === 1 ? "point" : "points"}, ${dry}% dry`,
                      es: `${place} puntos, ${dry}% seco`
                  }
                : { en: `${place} ${place === 1 ? "point" : "points"}`, es: `${place} puntos` },
            language
        );
    }
    if (kind === "spleef" || kind === "tnt-run")
        return speech.pickIn(
            { en: `${score} ${score === 1 ? "point" : "points"}`, es: `${score} puntos` },
            language
        );
    return null;
}
