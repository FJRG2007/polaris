/**
 * Playing the events players join and are taken somewhere for - a team duel, a
 * build battle - from the countdown to everybody being back where they were.
 *
 * In order:
 *
 * 1. The countdown reads `join` out of the chat (`joinTick`).
 * 2. At the start, who joined and is on is enrolled; fewer than two, and it is off.
 * 3. Ground is found the way every event finds it (`findPlace`: nobody's home,
 *    nobody's build, dry and even), and a box above it, in the air, is counted
 *    block by block: anything but air in it and the site is given up.
 * 4. The box is written down as the event's, then built - only into air.
 * 5. Each player's position, facing, world and game mode are written down, and
 *    only then are they moved in, put in adventure mode and handed the kit.
 * 6. At the end - finished, called off, failed, or picked up after a restart -
 *    `closeArena` takes the kit back (only it), gives back the game mode, sends
 *    each player to exactly where they stood, sends after them whatever they
 *    dropped, and takes the arena down, block kind by block kind.
 *
 * Each kind's own part of these steps - its box, what it is built of, its kit,
 * its start spots, "Go!", its tick and its results - is an `ArenaGame`
 * (`arena-game.ts`), looked up by kind (`arena-games.ts`). The team duel, the
 * build battle and the king of the ring are older than that, and are still
 * played by their own branches here.
 *
 * A player who is offline at the end cannot be sent anywhere. They log back in
 * inside the arena, so it stays up - closed, and safe to stand in - and is
 * written down as a leftover the minute sweep keeps trying: it sends them back
 * the moment they are on, and takes the arena down once nobody is left in it.
 */

import * as arena from "./arena";
import * as stage from "./stage";
import * as duel from "./team-duel";
import * as catalog from "../catalog";
import * as build from "./build-battle";
import * as arrival from "./arrival";
import * as hill from "./hill";
import * as hits from "./hits";
import * as hillService from "./hill-service";
import * as hitsService from "./hits-service";
import * as stashService from "./stash-service";
import * as pace from "./pace";
import * as inServer from "../in-server";
import * as commands from "../commands";
import * as speech from "../../speech";
import * as written from "../messages";
import type * as stored from "../state";
import type { ServerContainer } from "../../service";
import { gameOf } from "./arena-games";
import { NO_AIR, type PlaceRefusal } from "../place-search";
import { EventStopped, TooFew, type ItemSyntax, type KindContext } from "./arena-game";

/** What players read, in one language or - given `speech.EVERY` - in every one. */
const messages = speech.spoken(written);

export { EventStopped, TooFew, type KindContext, type Said } from "./arena-game";

const ONE_SIDED = "Everybody left in it was on the same team";
/** Why it was called off, as the history keeps it (and `messages.cancelReason`
 *  says it to players). */
const tooFew = (joined: number, needed: number) => `Only ${joined} joined; it needs ${needed}`;
/** How far from the players the ground under an arena is looked for. */
const PLACE_DISTANCE = 32;
/** How long an arena's chunks are waited for before its site is given up. */
const LOAD_WAIT_MS = 10_000;

/** What one run keeps in memory between ticks: nothing that must survive a restart. */
interface Memory {
    loadingSince: number | null;
    dealt: hits.Tally;
    kills: hits.Tally;
    lastHit: Map<string, number>;
    shieldedUntil: Map<string, number>;
    tour: number;
    /** The spot the tour stands at for each plot, once found clear. */
    views: Map<number, arena.Spot | null>;
}

const memories = new Map<string, Memory>();

function memoryOf(runId: string): Memory {
    let memory = memories.get(runId);
    if (!memory) {
        memory = {
            loadingSince: null,
            dealt: hits.tally(),
            kills: hits.tally(),
            lastHit: new Map(),
            shieldedUntil: new Map(),
            tour: -1,
            views: new Map()
        };
        memories.set(runId, memory);
    }
    return memory;
}

const lower = (name: string) => name.toLowerCase();

// ------------------------------------------------------------------ joining

/** Whoever typed `join` since the last look, added and greeted. */
export async function joinTick(ctx: KindContext): Promise<string[]> {
    const said = await ctx.chat();
    if (!said) return [];
    const known = new Set(ctx.run.joined.map(lower));
    const fresh: string[] = [];
    for (const one of said) {
        if (!arena.wantsToJoin(one.text) || known.has(lower(one.name))) continue;
        known.add(lower(one.name));
        fresh.push(one.name);
    }
    if (fresh.length === 0) return [];
    const before = ctx.run.joined.length;
    ctx.run = { ...ctx.run, joined: [...ctx.run.joined, ...fresh] };
    await ctx.persist();
    return fresh.map((name, index) =>
        commands.say(
            messages.tag(ctx.language) + messages.joinedLine(name, before + index + 1, ctx.language)
        )
    );
}

/** Above everybody's hotbar while the countdown runs. */
export function joinBar(run: stored.EventRun, language: speech.Speech): string {
    return `title @a actionbar ${commands.text(messages.joinedBar(run.joined.length, language))}`;
}

/** What the start adds for these events: a duel's teams and counts, named in
 *  the server's own language - a team has one name for everybody. */
export function beginLines(preset: catalog.EventPreset, language: catalog.Language): string[] {
    const game = gameOf(preset.kind);
    if (game) return game.beginLines?.(preset, language) ?? [];
    if (preset.kind !== "team-duel") return [];
    return duel.duelSetup(language === "es" ? ["Rojo", "Azul"] : ["Red", "Blue"]);
}

// ------------------------------------------------------------------ one tick

/**
 * One tick: the arena put up and everybody brought in, over the first few; the
 * game itself after that. Never decided early - both run their whole time.
 */
export async function arenaTick(ctx: KindContext, lines: string[]): Promise<string | null> {
    // Nothing hostile reaches it once it stands - a phantom least of all.
    if (ctx.run.arena) lines.push(...commands.hostilesOut(ctx.run.arena.box));
    if (ctx.run.readyAt === null) {
        // One step after another in the same tick while the next one has
        // nothing to wait for (`pace.STEPS_AT_ONCE`): enrolled, the arena up,
        // everybody brought in and the first look at whether they are there
        // follow at once rather than a tick apart. What has to wait - the place
        // searched, the chunks loading, somebody not there yet - ends the tick
        // as it always did, and the countdown still runs its whole three seconds.
        for (let step = 0; step < pace.STEPS_AT_ONCE; step += 1) {
            const before = readyStepOf(ctx.run);
            await readyStep(ctx, lines);
            const after = readyStepOf(ctx.run);
            // Arriving looks once, at once, and then waits for whoever is not in yet.
            if (ctx.run.readyAt !== null || after === before) break;
            // The site only just held: its chunks get a moment to load first.
            if (after === "site") await pace.pause(pace.LOAD_PAUSE_MS);
        }
        return null;
    }
    const game = gameOf(ctx.run.preset.kind);
    if (game) return game.tick(ctx, lines);
    if (ctx.run.preset.kind === "team-duel") await duelTick(ctx, lines);
    else if (ctx.run.preset.kind === "king-of-the-hill")
        await hillService.fightTick(ctx, ctx.tickSeconds, lines);
    else await buildTick(ctx, lines);
    return null;
}

/** Where an arena is on its way to being ready: the step `readyStep` takes next. */
function readyStepOf(
    run: stored.EventRun
): "enrolling" | "placing" | "placed" | "site" | "bringing" | "arriving" {
    if (!run.enrolled) return "enrolling";
    if (!run.arena) return run.site ? "site" : run.place ? "placed" : "placing";
    return arrival.isOpen(run.id) ? "arriving" : "bringing";
}

/** One step towards "Go!". */
async function readyStep(ctx: KindContext, lines: string[]): Promise<void> {
    if (!ctx.run.enrolled) await enroll(ctx, lines);
    else if (!ctx.run.arena) {
        if (gameOf(ctx.run.preset.kind)?.hits) await hitsService.ensure(ctx);
        await raise(ctx);
    }
    // Nothing counts until everybody brought in is there (`arrival`).
    else if (arrival.isOpen(ctx.run.id)) await arrivalTick(ctx, lines);
    else await bringIn(ctx);
}

/** Who takes part: who joined, is on, and is not still owed a trip back. */
async function enroll(ctx: KindContext, lines: string[]): Promise<void> {
    lines.push(...(await joinTick(ctx)));
    const language = ctx.language;
    const online = new Set(
        commands.readWhere(await ctx.server.say([commands.WHERE])).map((one) => lower(one.name))
    );
    const owed = await ctx.owed();
    const ready = ctx.run.joined.filter(
        (name) =>
            catalog.PLAYER_NAME.test(name) && online.has(lower(name)) && !owed.has(lower(name))
    );
    const game = gameOf(ctx.run.preset.kind);
    const most = game
        ? game.most(ctx.run)
        : ctx.run.preset.kind === "team-duel"
          ? duel.DUEL_MAX
          : ctx.run.preset.kind === "king-of-the-hill"
            ? hill.MOST
            : build.MAX_PLOTS;
    for (const name of ready.slice(most)) {
        lines.push(arena.tellTo(name, messages.tag(language) + messages.joinFull(language)));
    }
    const taking = ready.slice(0, most);
    const needed = catalog.joinersNeeded(ctx.run.preset);
    if (taking.length < needed) {
        await ctx.server.sayAll([
            ...lines,
            commands.say(
                messages.tag(language) + messages.notEnoughJoined(taking.length, needed, language)
            )
        ]);
        lines.length = 0;
        throw new TooFew(tooFew(taking.length, needed));
    }
    ctx.run = { ...ctx.run, joined: taking, enrolled: true };
    await ctx.persist();
}

function plotSize(run: stored.EventRun): number {
    return (run.preset.options as catalog.EventOptions<"build-battle">).plotSize;
}

/** The box the arena takes, above the ground found for it. */
function boxFor(run: stored.EventRun, place: stored.Point): stored.Box {
    const game = gameOf(run.preset.kind);
    if (game) return game.box(run, place);
    const floorY = place.y + arena.ALTITUDE;
    return run.preset.kind === "team-duel"
        ? duel.duelBox(place, floorY)
        : build.platformBox(place, floorY, run.joined.length, plotSize(run));
}

function fillsFor(run: stored.EventRun, box: stored.Box): { box: stored.Box; block: string }[] {
    const game = gameOf(run.preset.kind);
    if (game) return game.fills(run, box);
    return run.preset.kind === "team-duel"
        ? duel.duelFills(box)
        : build.platformFills(box, run.joined.length, plotSize(run));
}

function blocksFor(run: stored.EventRun, box: stored.Box, fills: { block: string }[]): string[] {
    const game = gameOf(run.preset.kind);
    // Bare ids: a block's state (`[facing=north]`) would keep it out of the
    // teardown (`arena.teardown`), which takes every state of the id.
    if (game) return [...new Set(game.blocks(run, box).map((id) => id.replace(/\[.*$/, "")))];
    const placed = run.preset.kind === "team-duel" ? [] : build.PLATFORM_BLOCKS;
    return [...new Set([...fills.map((one) => one.block), ...placed])];
}

/**
 * The arena put up, over a few ticks: ground found, the box above it loaded,
 * counted - nothing but air, or the site is given up - written down as ours,
 * and only then built.
 */
async function raise(ctx: KindContext): Promise<void> {
    // The hill's own: on the ground, or on a platform over the sea.
    if (ctx.run.preset.kind === "king-of-the-hill") {
        await hillService.raiseHill(ctx);
        return;
    }
    let run = ctx.run;
    const place = run.place;
    if (!place) {
        const game = gameOf(run.preset.kind);
        const reach = game
            ? game.reach(run)
            : run.preset.kind === "team-duel"
              ? duel.DUEL_REACH
              : build.platformReach(run.joined.length, plotSize(run));
        const options = run.preset.options as { place: catalog.EventPlace };
        const found = await ctx.findPlace(options.place, PLACE_DISTANCE, reach, "air", true);
        if (found === "failed") throw new EventStopped(NO_AIR);
        return;
    }
    const box = boxFor(run, place);
    if (box.y2 > arena.worldTop(await ctx.atLeast([1, 18]))) {
        await giveUpSite(ctx, place, "tooHigh");
        return;
    }
    if (!run.site) {
        // Written down before it is loaded, so whatever ends the event lets it go.
        ctx.run = { ...run, site: box };
        await ctx.persist();
        await ctx.server.sayAll([arena.forceloadArea(box, true)]);
        return;
    }
    const memory = memoryOf(run.id);
    let solid = 0;
    let waiting = false;
    for (const piece of arena.slices(box)) {
        const count = arena.readCount(await ctx.server.say([arena.solidCount(piece)]));
        if (count === "unloaded") waiting = true;
        else solid += count ?? Number.POSITIVE_INFINITY;
        if (solid > 0) break;
    }
    if (solid === 0 && waiting) {
        const now = Date.now();
        memory.loadingSince ??= now;
        if (now - memory.loadingSince < LOAD_WAIT_MS) return;
    }
    memory.loadingSince = null;
    if (solid > 0 || waiting) {
        await giveUpSite(ctx, place, solid > 0 ? "occupied" : "unloaded");
        return;
    }
    // Nothing but air: ours to build in, and written down as ours before a
    // single block goes in. What the kind needs to know of the server first
    // is asked now, and kept with the run.
    const game = gameOf(run.preset.kind);
    if (game?.prepare) {
        const prepared = await game.prepare(ctx);
        run = {
            ...run,
            game: { ...((run.game as Record<string, unknown> | null) ?? {}), ...prepared }
        };
    }
    const fills = fillsFor(run, box);
    const built: stored.Arena = { box, blocks: blocksFor(run, box, fills) };
    // What a kind puts in its chests is marked the way the kit is, so it is
    // read before anything is built - and kept for the kit.
    const marker = game?.decorate ? (run.marker ?? (await kitMarker(ctx))) : run.marker;
    ctx.run = { ...ctx.run, arena: built, marker, game: game?.built?.(run) ?? ctx.run.game };
    await ctx.persist();
    // Inside the server where the Polaris mod can (`in-server.build`: a block
    // cap a tick); otherwise a paced trip at a time (`pace.buildPacer`). Either
    // way a big arena never holds the server's tick for all of it at once.
    const building = pace.buildPacer();
    const raised = await inServer.build(
        ctx.server,
        fills.flatMap((one) =>
            arena.slices(one.box).map((piece) => arena.fillKeep(piece, one.block))
        ),
        (lines) => pace.inTrips([...lines], building, (trip) => ctx.server.sayAll(trip))
    );
    await ctx.server.sayAll([commands.CLEAR_MARK]);
    if (!raised) {
        await ctx.server.sayAll(arena.teardown(built));
        ctx.run = { ...ctx.run, arena: null };
        await giveUpSite(ctx, place, "refused");
        return;
    }
    // A protected area refuses blocks without a word: what was asked for has
    // to be there, or it comes down again and another place is tried.
    const floor = fills.at(-1)!;
    const probe = `execute in minecraft:overworld if block ${floor.box.x1} ${floor.box.y1} ${floor.box.z1} ${floor.block}`;
    if (commands.readTest(await ctx.server.say([probe])) !== "passed") {
        await ctx.server.sayAll(arena.teardown(built));
        ctx.run = { ...ctx.run, arena: null };
        await giveUpSite(ctx, place, "refused");
        return;
    }
    if (game?.decorate && marker)
        await ctx.server.sayAll(game.decorate(ctx.run, box, await syntaxOf(ctx, marker)));
}

/** How this server writes the items a kind puts somewhere itself. */
async function syntaxOf(ctx: KindContext, marker: stored.Marker): Promise<ItemSyntax> {
    return { marker, itemCommand: await ctx.atLeast([1, 17]) };
}

async function giveUpSite(ctx: KindContext, place: stored.Point, why: PlaceRefusal): Promise<void> {
    if (ctx.run.site) await ctx.server.sayAll([arena.forceloadArea(ctx.run.site, false)]);
    ctx.run = { ...ctx.run, site: null };
    await ctx.giveUpPlace(place, why);
}

/**
 * How the kit is marked, the way this server reads an item: the version's
 * choice, checked by asking the game to take the marked item from nobody -
 * `clear` of a tag no player has, 0 of them - which a server that writes items
 * the other way refuses to read. A kit in the wrong syntax is never given, and
 * never taken back either.
 */
async function kitMarker(ctx: KindContext): Promise<stored.Marker> {
    const guess: stored.Marker = (await ctx.atLeast([1, 20, 5])) ? "components" : "tag";
    const other: stored.Marker = guess === "components" ? "tag" : "components";
    const reads = async (marker: stored.Marker) =>
        commands.probeParsed(
            await ctx.server
                .say([`${arena.clearMarked("@a[tag=pe_probe]", "minecraft:stone", marker)} 0`])
                .catch(() => "")
        );
    if (await reads(guess)) return guess;
    return (await reads(other)) ? other : guess;
}

/**
 * Everybody in: where each of them is written down first, and never read again
 * for anybody already written down - a restart halfway through must not take
 * the arena for somebody's home.
 */
async function bringIn(ctx: KindContext): Promise<void> {
    const run = ctx.run;
    const language = ctx.language;
    const box = run.arena!.box;
    const game = gameOf(run.preset.kind);
    const duelling = run.preset.kind === "team-duel";
    const hillside = run.preset.kind === "king-of-the-hill";
    const marker: stored.Marker = run.marker ?? (await kitMarker(ctx));
    // Nothing in the hands on the hill: fists only. Its kit is the crown the
    // one ahead wears (`hill-service`), taken back with the rest.
    const kit = game
        ? game.kit(run)
        : duelling
          ? duel.duelKit((run.preset.options as catalog.EventOptions<"team-duel">).kit)
          : hillside
            ? [hill.CROWN]
            : build.KIT_IDS;
    const moved = new Set(
        [...run.entrants, ...(run.sentOut ?? []), ...(run.keptOut ?? [])].map((one) =>
            lower(one.name)
        )
    );
    const waiting = run.joined.filter((name) => !moved.has(lower(name)));
    if (waiting.length > 0) {
        const say = (line: string) => ctx.server.say([line]);
        const where = new Map(
            commands.readWhere(await say(commands.WHERE)).map((one) => [lower(one.name), one])
        );
        const facing = commands.readFacing(await say(commands.FACING));
        const worlds = commands.readDimensions(await say(commands.DIMENSIONS));
        const modes = arena.readGamemodes(await say(arena.READ_GAMEMODES));
        const uuids = arena.readUuids(await say(arena.READ_UUIDS));
        const fresh: stored.Entrant[] = [];
        for (const name of waiting) {
            const at = where.get(lower(name));
            const dimension = at ? worlds.get(at.name) : undefined;
            const gamemode = at ? modes.get(at.name) : undefined;
            // Gone, or unreadable: not moved at all.
            if (!at || !dimension || !gamemode) continue;
            const turned = facing.get(at.name) ?? { yaw: 0, pitch: 0 };
            const index = run.joined.indexOf(name);
            fresh.push({
                name: at.name,
                uuid: uuids.get(at.name) ?? null,
                dimension,
                x: at.x,
                y: at.y,
                z: at.z,
                yaw: turned.yaw,
                pitch: turned.pitch,
                gamemode,
                side: game ? game.side(run, index) : duelling ? index % 2 : index,
                away: true,
                tagged: true,
                stash: null
            });
        }
        const needed = catalog.joinersNeeded(run.preset);
        if (run.entrants.length + fresh.length < needed) {
            throw new TooFew(tooFew(run.entrants.length + fresh.length, needed));
        }
        ctx.run = { ...ctx.run, entrants: [...run.entrants, ...fresh], marker, kit };
        await ctx.persist();
    }
    // Each player's lines in, once what they carry is put away.
    const options = run.preset.options;
    const theme =
        game || duelling || hillside
            ? null
            : build.themeFor(options as catalog.EventOptions<"build-battle">, run.id, language);
    if (theme !== null)
        // Kept in the server's own language; shown in each reader's.
        ctx.run = {
            ...ctx.run,
            theme:
                ctx.run.theme ??
                build.themeFor(options as catalog.EventOptions<"build-battle">, run.id, ctx.home)
        };
    const overGround = hillside ? await ctx.atLeast([1, 19, 4]) : false;
    const linesIn = (one: stored.Entrant): string[] => {
        if (hillside)
            return hillService.enterLines(ctx.run, one.name, one.side, overGround, language);
        // In, and nothing more: the kit, the side's colors and the theme are
        // handed out at "Go!", to everybody at once (`goLines`).
        return [
            ...arena.enter(one.name, spotsOf(ctx.run).get(lower(one.name))!),
            ...(duelling ? [duel.joinTeam(one.name, one.side)] : []),
            ...(game?.enterLines?.(ctx.run, one) ?? []),
            arena.protect(one.name)
        ];
    };
    // What everybody carries put away first, then everybody in at once, in one
    // batch: brought in one at a time, between one player's stash and the
    // next, a big server watched its players arrive a few at a time. Whatever
    // somebody picks up while the others are put away is caught by the last
    // look below, as anything picked up on the way in always was.
    await stashAll(ctx, false);
    // Those kept out are no longer entrants: everybody left goes in.
    await ctx.server.sayAll(ctx.run.entrants.flatMap(linesIn));
    // And once in, a last look: whatever turned up on them on the way is put
    // away with the rest; anybody it cannot be taken from is sent back out.
    await stashAll(ctx, true);
    // Too few left once those kept out are: called off, and everybody brought
    // in sent back with their things.
    const needed = catalog.joinersNeeded(run.preset);
    if (ctx.run.entrants.length < needed) throw new TooFew(tooFew(ctx.run.entrants.length, needed));
    // Everybody left on the one team: nobody to play against.
    const sides = game ? (game.teams ?? 0) : duelling ? 2 : 0;
    if (
        Array.from({ length: sides }, (_, side) => side).some(
            (side) => !ctx.run.entrants.some((one) => one.side === side)
        )
    )
        throw new TooFew(ONE_SIDED);
    // The clock, the kit and "Go!" wait for everybody to be in.
    arrival.open(ctx.run.id, Date.now());
}

/** Where each entrant starts, by name in lower case: a duel's side, a build
 *  battle's plot. Not the hill's, which has its own round the circle. */
function spotsOf(run: stored.EventRun): Map<string, arena.Spot> {
    const box = run.arena!.box;
    const spots = new Map<string, arena.Spot>();
    const game = gameOf(run.preset.kind);
    if (game) {
        for (const one of run.entrants) spots.set(lower(one.name), game.spot(run, one));
        return spots;
    }
    const counts = [0, 0];
    for (const one of run.entrants) {
        if (run.preset.kind === "team-duel") {
            const slot = counts[one.side] ?? 0;
            counts[one.side] = slot + 1;
            spots.set(lower(one.name), duel.sideSpot(box, one.side, slot));
        } else
            spots.set(
                lower(one.name),
                build.plotSpot(box, one.side, plotSize(run), run.joined.length)
            );
    }
    return spots;
}

/**
 * One tick of the wait before the start (`arrival`): nobody hurt, nothing
 * counted, nothing handed out - until everybody brought in is seen in the
 * arena, or the wait runs out. Then the countdown, everybody put back on their
 * own start spot - nobody in first is any closer to anything - and "Go!": the
 * clock started, the kit and the theme handed out to all of them at once.
 */
async function arrivalTick(ctx: KindContext, lines: string[]): Promise<void> {
    const run = ctx.run;
    const language = ctx.language;
    const hillside = run.preset.kind === "king-of-the-hill";
    const box = run.arena!.box;
    const names = run.entrants.map((one) => one.name);
    const where = commands.readWhere(await ctx.server.say([commands.IN_OVERWORLD]));
    const here = new Map(where.map((one) => [lower(one.name), one]));
    const seen = arrival.look(run.id, ctx.now, names, (name) => {
        const at = here.get(lower(name));
        if (!at) return false;
        return hillside ? hillService.onHill(run, at) : arena.contains(box, at);
    });
    const arrived = (name: string) => arrival.hasArrived(run.id, name);
    const everybody = `@a[tag=${arena.IN_ARENA}]`;
    if (hillside) lines.push(...(await hillService.holdLines(ctx, where, arrived)));
    else {
        const spots = spotsOf(run);
        for (const one of run.entrants) {
            const at = here.get(lower(one.name));
            // Wandered out - a chorus fruit, a fall: back on their own spot.
            if (at && arrived(one.name) && !arena.contains(box, at))
                lines.push(arena.moveTo(one.name, spots.get(lower(one.name))!));
            lines.push(arena.protect(one.name), arena.feed(one.name));
        }
        lines.push(...arena.keepThrown(box), ...(gameOf(run.preset.kind)?.holdLines?.(run) ?? []));
    }
    if (!seen.start) {
        lines.push(arrival.waitingLine(everybody, seen, language));
        return;
    }
    arrival.forget(run.id);
    // What this tick has to say first, then the countdown on time.
    await ctx.server.sayAll(lines.splice(0, lines.length));
    await arrival.countdown((out) => ctx.server.sayAll(out), everybody, language);
    const now = Date.now();
    const seconds =
        run.preset.minutes * 60 +
        (run.preset.kind === "build-battle"
            ? (run.preset.options as catalog.EventOptions<"build-battle">).voteSeconds
            : 0);
    const started = { readyAt: now, startsAt: now, endsAt: now + seconds * 1000 };
    // Everybody whole before anything is counted (`arena.HEAL_INSIDE`).
    await ctx.server.sayAll([arena.HEAL_INSIDE]);
    if (hillside) {
        // Written down first: nothing is handed out on the hill.
        ctx.run = { ...ctx.run, ...started };
        await ctx.persist();
        lines.push(...(await hillService.goLines(ctx)));
    } else {
        // Handed out first and only then written down: a restart in between
        // hands the kit out again (marked, and taken back at the end) rather
        // than starting a fight with nothing in anybody's hands.
        // The shield straight into the off hand where the bag was emptied on
        // the way in (`stashOne`, from 1.17); before that, beside what they carry.
        const game = gameOf(run.preset.kind);
        await ctx.server.sayAll(
            game
                ? await game.goLines(ctx, await syntaxOf(ctx, ctx.run.marker!))
                : goLines(ctx.run, language, await ctx.atLeast([1, 17]))
        );
        ctx.run = { ...ctx.run, ...started };
        await ctx.persist();
    }
    lines.push(
        ...arrival.startedWithoutLines(seen, language),
        commands.sound(commands.SOUNDS.start)
    );
}

/** "Go!" in a duel or a build battle: everybody on their own spot, the kit in
 *  their hands - the shield in the off hand, when `offhand` - and what to do
 *  on their screen. */
function goLines(run: stored.EventRun, language: speech.Speech, offhand: boolean): string[] {
    const spots = spotsOf(run);
    const marker = run.marker!;
    const out: string[] = [];
    if (run.preset.kind === "team-duel") {
        const options = run.preset.options as catalog.EventOptions<"team-duel">;
        for (const one of run.entrants)
            out.push(
                arena.moveTo(one.name, spots.get(lower(one.name))!),
                ...run.kit.map((id) =>
                    offhand && id === duel.OFFHAND_ITEM
                        ? arena.equipMarked(one.name, "weapon.offhand", id, marker, arena.LASTS)
                        : arena.giveMarked(one.name, id, 1, marker, arena.LASTS)
                ),
                ...arena.titleTo(
                    one.name,
                    messages.duelEnterTitle(one.side, language),
                    messages.duelEnterSubtitle(options.downHearts, language)
                )
            );
        return out;
    }
    const theme = build.themeFor(
        run.preset.options as catalog.EventOptions<"build-battle">,
        run.id,
        language
    );
    const palette = build.PALETTES[build.paletteFor(run.id)].name;
    for (const one of run.entrants)
        out.push(
            arena.moveTo(one.name, spots.get(lower(one.name))!),
            ...build.kitCommands(one.name, marker, build.paletteFor(run.id)),
            ...arena.titleTo(
                one.name,
                messages.themeTitle(language),
                `&f${theme} &7- ${speech.pickIn(palette, language)}`
            )
        );
    out.push(
        commands.say(messages.tag(language) + messages.themeLine(theme, language)),
        commands.say(messages.tag(language) + messages.materialLine(palette, language))
    );
    return out;
}

/**
 * Every entrant's own things put away before they are brought in and handed
 * the kit (`stash`), written into the run as they are kept - or, `inside`, what
 * turned up on them on the way in put away with the rest. From 1.17, which has
 * `item`; before it, the kit goes beside what they carry, as it always has.
 *
 * Side by side, their reads and writes sharing trips (`pace.coalescing`): one
 * trip a step for everybody rather than one each. Whoever cannot have all of
 * it put away is then kept out (`keptOut`) one at a time, in order, as before:
 * sending somebody back changes the run in ways that must not cross.
 */
async function stashAll(ctx: KindContext, inside: boolean): Promise<void> {
    const entrants = [...ctx.run.entrants];
    const shared = pace.coalescing(ctx.server);
    const settled = await Promise.allSettled(
        entrants.map((one) => stashFor(ctx, one, inside, shared))
    );
    const failed = settled.find((outcome) => outcome.status === "rejected");
    if (failed) throw failed.reason;
    for (const [at, one] of entrants.entries()) {
        const outcome = settled[at]!;
        const result = outcome.status === "fulfilled" ? outcome.value : null;
        if (result?.refused) await keptOut(ctx, one, inside, result.refused);
    }
}

/** What putting `one`'s things away came to; null for nobody to put away. */
async function stashFor(
    ctx: KindContext,
    one: stored.Entrant,
    inside: boolean,
    server: ServerContainer = ctx.server
): Promise<stashService.StashResult | null> {
    if (!one.away || (!inside && one.stash)) return null;
    if (!(await ctx.atLeast([1, 17]))) return null;
    const keep = keeper(ctx, one.name);
    return stashService.stashIn(server, ctx.stashOwner, one.name, keep, inside ? one.stash : null);
}

/** `name`'s stash written into the run as it is kept, and as it is given back. */
function keeper(ctx: KindContext, name: string) {
    return async (kept: stored.Entrant["stash"]) => {
        ctx.run = {
            ...ctx.run,
            entrants: ctx.run.entrants.map((each) =>
                each.name === name ? { ...each, stash: kept } : each
            )
        };
        await ctx.persist();
    };
}

/**
 * Somebody whose things could not all be put away (`refused`): told why, sent
 * back where they were if they had been brought in, and handed back whatever
 * was taken. Answers false: they are not in.
 */
async function keptOut(
    ctx: KindContext,
    one: stored.Entrant,
    inside: boolean,
    refused: NonNullable<stashService.StashResult["refused"]>
): Promise<boolean> {
    const keep = keeper(ctx, one.name);
    let entrant = ctx.run.entrants.find((each) => each.name === one.name) ?? one;
    ctx.run = {
        ...ctx.run,
        keptOut: await stashService.keepOut(
            ctx.server,
            ctx.run.keptOut,
            one.name,
            refused,
            ctx.language
        )
    };
    const drop = async () => {
        ctx.run = {
            ...ctx.run,
            entrants: ctx.run.entrants.filter((each) => each.name !== one.name)
        };
        await ctx.persist();
        return false;
    };
    // Never brought in: still where they stand, handed back whatever was taken.
    if (!inside) {
        if (!entrant.stash) return drop();
        const how = await stashService.giveBack(ctx.server, one.name, entrant.stash, keep);
        if (how === "done" || how === "failed") return drop();
    }
    // Back where they were, with whatever was taken given back: the way an end
    // sends anybody home, for this one player.
    entrant = ctx.run.entrants.find((each) => each.name === one.name) ?? entrant;
    const leftover = leftoverOf(ctx.run);
    const left = leftover
        ? await closeArena(
              ctx.server,
              { ...leftover, arena: null, site: null, entrants: [entrant], gamerules: {} },
              ctx.language
          )
        : null;
    // Not on to be sent back: still owed the trip, at the end with everybody -
    // never played, and never brought back in by a tick.
    if (left) {
        ctx.run = {
            ...ctx.run,
            entrants: ctx.run.entrants.filter((each) => each.name !== one.name),
            sentOut: [
                ...(ctx.run.sentOut ?? []).filter((each) => each.name !== one.name),
                ...left.entrants
            ]
        };
        await ctx.persist();
        return false;
    }
    return drop();
}

// ------------------------------------------------------------------ team duel

async function duelTick(ctx: KindContext, lines: string[]): Promise<void> {
    const run = ctx.run;
    const language = ctx.language;
    const options = run.preset.options as catalog.EventOptions<"team-duel">;
    const box = run.arena!.box;
    const memory = memoryOf(run.id);
    const now = ctx.now;
    const say = (line: string) => ctx.server.say([line]);
    const hp = commands.readScores(await say(duel.READ_HP));
    const dealt = commands.readScores(await say(duel.READ_DEALT));
    const died = commands.readScores(await say(duel.READ_DIED));
    const kills = commands.readScores(await say(duel.READ_KILLS));
    const here = new Map(
        commands.readWhere(await say(commands.IN_OVERWORLD)).map((one) => [lower(one.name), one])
    );
    const health = duel.healthOf(
        hp,
        run.entrants.map((one) => one.name).filter((name) => here.has(lower(name)))
    );

    // Who struck and who killed since the last look; nothing on the first
    // after a restart, and a first score counted from 0.
    const on = new Set(here.keys());
    const killsSince = hits.rose(memory.kills, kills, on);
    for (const name of hits.rose(memory.dealt, dealt, on).keys()) memory.lastHit.set(name, now);
    // Whom the game says last hurt whoever is brought low (from 1.19.4).
    const attackers = await hitsService.attackers(
        ctx,
        run.entrants
            .filter((one) => {
                const hearts = health.get(one.name);
                return (
                    hearts !== undefined &&
                    hearts > 0 &&
                    hearts <= options.downHearts * 2 &&
                    (memory.shieldedUntil.get(one.name) ?? 0) <= now
                );
            })
            .map((one) => one.name)
    );

    const points = { ...run.points };
    const tally = { ...run.tally };
    let scored = false;
    const counts = [0, 0];
    for (const one of run.entrants) {
        const slot = counts[one.side] ?? 0;
        counts[one.side] = slot + 1;
        const spot = duel.sideSpot(box, one.side, slot);
        const hearts = health.get(one.name);
        // Not on: nothing to do until they are back.
        if (hearts === undefined) continue;
        const rivals = run.entrants
            .filter((other) => other.side !== one.side)
            .map((other) => other.name);
        const dead = (died.get(one.name) ?? 0) > 0;
        const low =
            hearts > 0 &&
            hearts <= options.downHearts * 2 &&
            (memory.shieldedUntil.get(one.name) ?? 0) <= now;
        if (dead || low) {
            // A death is credited by the game's kill count: whoever comes back
            // from one is a new player, and the game forgets who hurt them.
            const by = duel.creditFor(
                rivals,
                killsSince,
                memory.lastHit,
                now,
                dead ? undefined : attackers.get(lower(one.name))
            );
            const other = String(1 - one.side);
            tally[other] = (tally[other] ?? 0) + 1;
            if (by) {
                points[by] = (points[by] ?? 0) + 1;
                lines.push(commands.setScore(by, points[by]!));
            }
            lines.push(
                commands.say(messages.tag(language) + messages.duelDown(one.name, by, language))
            );
            if (dead) lines.push(`scoreboard players set ${one.name} ${duel.DIED} 0`);
            scored = true;
        }
        const at = here.get(lower(one.name));
        // Brought low, or back from a death at home, or out of it any other
        // way: back to their side, healed and shielded for a moment.
        if (hearts > 0 && (low || !at || !arena.contains(box, at))) {
            lines.push(...duel.sendBack(one.name, spot));
            memory.shieldedUntil.set(one.name, now + duel.SHIELD_SECONDS * 1000);
        }
        lines.push(
            arena.feed(one.name),
            arena.actionbarTo(
                one.name,
                messages.duelStatus(one.side, points[one.name] ?? 0, language)
            )
        );
    }
    const left = (run.endsAt - now) / 1000;
    lines.push(
        `bossbar set ${commands.BAR} name ${commands.text(
            messages.duelBar(tally["0"] ?? 0, tally["1"] ?? 0, left, language)
        )}`,
        ...arena.keepThrown(box)
    );
    if (scored) {
        ctx.run = { ...ctx.run, points, tally };
        await ctx.persist();
    }
}

// ------------------------------------------------------------------ build battle

/**
 * Where everybody stands to see one plot: the first of its spots over the roof
 * whose feet and head are both air, asked once per plot and remembered; null
 * when none is, and then nobody is moved.
 */
async function tourView(
    ctx: KindContext,
    memory: Memory,
    box: stored.Box,
    plot: number,
    size: number,
    count: number
): Promise<arena.Spot | null> {
    const known = memory.views.get(plot);
    if (known !== undefined) return known;
    let found: arena.Spot | null = null;
    for (const spot of build.plotViews(box, plot, size, count)) {
        const clear = async (above: number) =>
            commands.readTest(await ctx.server.say([build.airAt(spot, above)])) === "passed";
        if ((await clear(0)) && (await clear(1))) {
            found = spot;
            break;
        }
    }
    memory.views.set(plot, found);
    return found;
}

async function buildTick(ctx: KindContext, lines: string[]): Promise<void> {
    const run = ctx.run;
    const language = ctx.language;
    const options = run.preset.options as catalog.EventOptions<"build-battle">;
    const box = run.arena!.box;
    const now = ctx.now;
    const theme = run.theme ?? "";
    const buildEnds = run.buildEndsAt ?? run.readyAt! + run.preset.minutes * 60_000;
    const memory = memoryOf(run.id);
    const count = run.joined.length;
    // The tour: everybody stands at one plot after another, a few seconds each.
    const plots = run.entrants.map((one) => one.side).sort((left, right) => left - right);
    const step = build.tourStep(options.voteSeconds, plots.length);
    const index =
        run.voting && plots.length > 0
            ? Math.floor((now - buildEnds) / 1000 / step) % plots.length
            : -1;
    const touring = index >= 0 ? plots[index]! : null;
    // The tour's spot over the roof, found clear once per plot.
    const view =
        touring === null
            ? null
            : await tourView(ctx, memory, box, touring, options.plotSize, count);
    const spotOf = (one: stored.Entrant) =>
        view ?? build.plotSpot(box, one.side, options.plotSize, count);
    const here = new Map(
        commands
            .readWhere(await ctx.server.say([commands.IN_OVERWORLD]))
            .map((one) => [lower(one.name), one])
    );
    lines.push(...arena.keepThrown(box));
    const bounds = run.voting ? build.tourBounds(box) : box;
    for (const one of run.entrants) {
        const at = here.get(lower(one.name));
        // Out of it some other way - a chorus fruit, say: back where they belong.
        if (at && !arena.contains(bounds, at)) lines.push(arena.moveTo(one.name, spotOf(one)));
        // Nobody is hurt here, least of all by another builder on the tour -
        // nor by stepping off the roof while touring it.
        lines.push(arena.feed(one.name), arena.protect(one.name));
        if (run.voting) lines.push(arena.floatDown(one.name));
    }
    if (now < buildEnds) {
        for (const one of run.entrants) {
            lines.push(
                arena.actionbarTo(
                    one.name,
                    messages.plotBar(theme, one.side + 1, (buildEnds - now) / 1000, language)
                )
            );
        }
        // Everybody still here pressed [Done]: the vote now, not when the time is up.
        if (!(await doneTick(ctx, lines, here))) return;
    }
    if (!run.voting) {
        // Said while building is not a vote.
        await ctx.chat();
        // The list of who is done gives the side panel back to the votes.
        if (run.doneOffered)
            lines.push(
                commands.JOIN_LIST_OFF,
                `scoreboard objectives setdisplay sidebar ${commands.SCORE}`
            );
        // The kit taken back, and any of it lying about, so nothing more can be
        // placed - on anybody's plot - while everybody tours them.
        if (run.marker) lines.push(arena.killMarkedDrops(box, run.marker));
        for (const one of run.entrants) {
            lines.push(
                ...(run.marker
                    ? run.kit.map((id) => arena.clearMarked(one.name, id, run.marker!))
                    : []),
                ...arena.titleTo(
                    one.name,
                    messages.voteTitle(language),
                    messages.themeLine(theme, language)
                )
            );
        }
        lines.push(
            commands.say(messages.tag(language) + messages.voteHow(language)),
            commands.sound(commands.SOUNDS.start)
        );
        ctx.run = { ...ctx.run, voting: true };
        memory.tour = -1;
        await ctx.persist();
        return;
    }
    if (touring === null) return;
    if (index !== memory.tour) {
        memory.tour = index;
        for (const one of run.entrants) {
            lines.push(
                // Only to a spot found clear; with none, they look from where they are.
                ...(view ? [arena.moveTo(one.name, view)] : []),
                ...arena.titleTo(one.name, messages.plotTitle(touring + 1, language), "")
            );
        }
    }
    const owners = new Map(run.entrants.map((one) => [one.side + 1, one.name]));
    let votes = run.votes;
    let changed = false;
    for (const { name, text } of (await ctx.chat()) ?? []) {
        const number = build.readVote(text);
        if (number === null) continue;
        const cast = build.castVote(votes, name, number, owners);
        votes = cast.votes;
        changed ||= cast.outcome === "counted";
        const reply =
            cast.outcome === "counted"
                ? messages.voteCounted(number, language)
                : cast.outcome === "own"
                  ? messages.voteOwn(language)
                  : cast.outcome === "again"
                    ? messages.voteAgain(language)
                    : messages.voteNoPlot(number, language);
        lines.push(arena.tellTo(name, messages.tag(language) + reply));
    }
    if (changed) {
        const counted = build.countVotes(votes);
        for (const [owner, total] of counted) lines.push(commands.setScore(owner, total));
        ctx.run = { ...ctx.run, votes, points: Object.fromEntries(counted) };
        await ctx.persist();
    }
    for (const one of run.entrants) {
        lines.push(
            arena.actionbarTo(
                one.name,
                messages.voteBar(touring + 1, (run.endsAt - now) / 1000, language)
            )
        );
    }
}

/**
 * The [Done] button, a while into the building: offered to each builder in
 * their language, read with the join buttons' trigger (and typed `done` /
 * `undo`), shown on the side panel as "Done: 2/5". True once every builder
 * still on the server is done - the building then ends at once and the vote
 * takes its own time from now.
 */
async function doneTick(
    ctx: KindContext,
    lines: string[],
    here: ReadonlyMap<string, unknown>
): Promise<boolean> {
    const run = ctx.run;
    const language = ctx.language;
    if (ctx.now < run.readyAt! + build.doneOfferAfter(run.preset.minutes * 60_000)) return false;
    const builders = new Map(run.entrants.map((one) => [lower(one.name), one.name]));
    const doneButton = (lead: string, name: string) => {
        const offer = messages.doneOffer(language);
        return commands.buttonsLine(name, messages.tag(language) + lead, [
            { ...offer.done, color: "green", value: commands.DONE_VALUE }
        ]);
    };
    if (!run.doneOffered) {
        lines.push(...commands.joinTriggerLines());
        for (const name of builders.values())
            lines.push(doneButton(messages.doneOffer(language).lead, name));
        ctx.run = { ...ctx.run, doneOffered: true };
        await ctx.persist();
    }
    let done = ctx.run.done;
    for (const said of (await ctx.chat()) ?? []) {
        const name = builders.get(lower(said.name));
        const word = build.readDone(said.text);
        if (!name || !word) continue;
        const marked = done.some((one) => lower(one) === lower(name));
        if (word === "done" && !marked) {
            done = [...done, name];
            const back = messages.doneMarked(language);
            lines.push(
                commands.buttonsLine(name, messages.tag(language) + back.lead, [
                    { ...back.undo, color: "gray", value: commands.UNDO_VALUE }
                ])
            );
        } else if (word === "undo" && marked) {
            done = done.filter((one) => lower(one) !== lower(name));
            lines.push(doneButton(messages.undoMarked(language), name));
        }
    }
    if (done !== ctx.run.done) {
        ctx.run = { ...ctx.run, done };
        await ctx.persist();
    }
    const present = [...builders.values()].filter((name) => here.has(lower(name)));
    const finished = present.filter((name) => done.some((one) => lower(one) === lower(name)));
    lines.push(
        ...commands.joinListLines(
            messages.doneListTitle(finished.length, present.length, language),
            finished
        )
    );
    if (!build.everybodyDone([...builders.values()], new Set(here.keys()), done)) return false;
    const options = run.preset.options as catalog.EventOptions<"build-battle">;
    ctx.run = {
        ...ctx.run,
        buildEndsAt: ctx.now,
        endsAt: ctx.now + options.voteSeconds * 1000
    };
    lines.push(commands.say(messages.tag(language) + messages.allDone(language)));
    await ctx.persist();
    return true;
}

// ------------------------------------------------------------------ the end

/** The final scores, and everybody who took part. */
export function arenaResults(run: stored.EventRun): {
    scores: Map<string, number>;
    took: string[];
} {
    const game = gameOf(run.preset.kind);
    const counted = game
        ? game.results(run)
        : run.preset.kind === "build-battle"
          ? build.countVotes(run.votes)
          : new Map(Object.entries(run.points));
    const scores = new Map(run.entrants.map((one) => [one.name, counted.get(one.name) ?? 0]));
    return { scores, took: [...scores.keys()] };
}

export function standings(run: stored.EventRun): { name: string; score: number }[] {
    const after = tiebreak(run) ?? {};
    const second = (name: string) => after[name] ?? 0;
    return [...arenaResults(run).scores.entries()]
        .map(([name, score]) => ({ name, score }))
        .sort((left, right) => right.score - left.score || second(left.name) - second(right.name));
}

/** What breaks a tie on score, the lower the better; undefined for a kind
 *  where a tie stays one. */
export function tiebreak(run: stored.EventRun): Record<string, number> | undefined {
    return gameOf(run.preset.kind)?.tiebreak?.(run);
}

/** A kind's own teams and counts, removed with the rest of the event's. */
export function endLines(run: stored.EventRun): string[] {
    return gameOf(run.preset.kind)?.endLines?.(run) ?? [];
}

/**
 * What the end owes each entrant who is not on now (`ArenaGame.owedLines`),
 * kept for `until`. One read of who is on, and only for a kind that owes any.
 */
export async function owedAtEnd(
    server: ServerContainer,
    run: stored.EventRun,
    until: number
): Promise<stored.OwedLines[]> {
    const owe = gameOf(run.preset.kind)?.owedLines;
    if (!owe || run.entrants.length === 0) return [];
    const online = new Set(
        commands.readWhere(await server.say([commands.WHERE])).map((one) => lower(one.name))
    );
    return run.entrants
        .filter((one) => !online.has(lower(one.name)))
        .flatMap((one) => owe(run, one.name).map((owed) => ({ player: one.name, ...owed, until })));
}

/** Whether a kind sends lines between ticks (`quickLines`). */
export function quickens(preset: catalog.EventPreset): boolean {
    return preset.kind === "build-battle" || Boolean(gameOf(preset.kind)?.quickLines);
}

/** What a kind sends between ticks once it is under way: one batch, nothing read. */
export function quickLines(run: stored.EventRun): string[] {
    // Before the pick-up delay is out, mostly: what the brush broke is kit again
    // by the time a builder walks over it.
    if (run.preset.kind === "build-battle")
        return run.readyAt === null || !run.arena || !run.marker || run.voting
            ? []
            : build.reclaimLines(run.arena.box, run.marker, build.paletteFor(run.id));
    const game = gameOf(run.preset.kind);
    if (!game?.quickLines || run.readyAt === null || !run.arena) return [];
    return game.quickLines(run);
}

/** Said with the results: how the teams did, what the theme was. */
export function resultLines(run: stored.EventRun, language: speech.Speech): string[] {
    if (run.readyAt === null) return [];
    const game = gameOf(run.preset.kind);
    if (game) return game.resultLines(run, language);
    if (run.preset.kind === "team-duel") {
        return [
            commands.say(messages.duelResult(run.tally["0"] ?? 0, run.tally["1"] ?? 0, language))
        ];
    }
    if (!run.theme) return [];
    const options = run.preset.options as catalog.EventOptions<"build-battle">;
    return [commands.say(messages.themeWas(build.themeFor(options, run.id, language), language))];
}

/** What of a run still has to be undone: the arena, and whoever it moved. */
export function leftoverOf(
    run: stored.EventRun,
    gamerules: Readonly<Record<string, string>> = {}
): stored.ArenaLeftover | null {
    const entrants = [...run.entrants, ...(run.sentOut ?? [])].filter((one) => one.away);
    if (!run.arena && !run.site && entrants.length === 0) return null;
    return {
        id: run.id,
        kind: run.preset.kind,
        arena: run.arena,
        site: run.site,
        marker: run.marker,
        kit: run.kit,
        entrants,
        gamerules: { ...gamerules },
        keepForced: run.keepForced ? [...run.keepForced] : null,
        createdAt: Date.now()
    };
}

function releases(left: stored.ArenaLeftover): string[] {
    const areas = new Map<string, stored.Box>();
    for (const box of [left.site, left.arena?.box]) if (box) areas.set(arena.region(box), box);
    return [...areas.values()].map((box) => arena.forceloadArea(box, false));
}

/**
 * Everything an arena event did, undone as far as it can be now: the kit lying
 * about removed, every player who is on sent back with their kit taken, their
 * game mode and - once they are down - their own things given back, the game
 * rules owed put back after that, and - once nobody is left in it - the arena
 * taken down. Answers what is still to do, or null when nothing
 * is. Never throws: whatever it did not get to is in what it answers.
 */
export async function closeArena(
    server: ServerContainer,
    left: stored.ArenaLeftover,
    language: speech.Speech | null = null
): Promise<stored.ArenaLeftover | null> {
    memories.delete(left.id);
    arrival.forget(left.id);
    let rules = left.gamerules;
    const remaining: stored.Entrant[] = [];
    // Who has been seen to: home and given back, or written into `remaining`.
    // Anybody else is still owed everything, should this stop half way.
    const handled = new Set<number>();
    try {
        const box = left.arena?.box ?? null;
        if (box && left.marker) await server.sayAll([arena.killMarkedDrops(box, left.marker)]);
        const closing = box ? (gameOf(left.kind)?.closeLines?.(box) ?? []) : [];
        if (closing.length > 0) await server.sayAll(closing);
        const owed: { at: number; one: stored.Entrant }[] = [];
        for (const [at, one] of left.entrants.entries()) {
            if (one.away && arena.commandable(one)) owed.push({ at, one });
            else handled.add(at);
        }
        // Sent home already, by an end that stopped before it gave everything
        // back: not moved again, only given what they are still owed.
        // Everybody's reads and writes below share trips (`pace.coalescing`).
        const shared = pace.coalescing(server);
        const say = (line: string) => shared.say([line]);
        const back = new Set<number>();
        const wereBack = await Promise.all(
            owed.map(
                async ({ one }) =>
                    one.tagged && (await commands.alreadyBack(say, one.name, arena.IN_ARENA))
            )
        );
        for (const [index, { at }] of owed.entries()) if (wereBack[index]) back.add(at);
        const going = owed.filter(({ at }) => !back.has(at));
        // The kit off and unable to fall to their death, then everybody home
        // at once - one trip, never one player after another - with their own
        // game mode only there.
        const homeward = [
            ...owed
                .filter(({ at }) => back.has(at))
                .flatMap(({ one }) => stage.fallProof(one.name)),
            ...going.flatMap(({ one }) => arena.homeward(one, left.marker, left.kit))
        ];
        if (homeward.length > 0) await server.sayAll(homeward);
        const answers = await commands.answersOf(
            server,
            going.map(({ one }) => arena.sendHome(one))
        );
        const home = new Set<number>();
        for (const [index, { at, one }] of going.entries()) {
            if (arena.wentHome(answers[index]!)) home.add(at);
            else {
                remaining.push(one);
                handled.add(at);
            }
        }
        const there = going.filter(({ at }) => home.has(at));
        const settled = there.flatMap(({ one }) => {
            const thrown = box ? arena.sendThrown(box, one) : null;
            return [arena.homeMode(one), arena.leftArena(one.name), ...(thrown ? [thrown] : [])];
        });
        if (settled.length > 0) await server.sayAll(settled);
        // Their own things back only once they are home and down: nothing is
        // given back to a player who could still fall with it. Everybody is
        // home by now, and they are seen to side by side: each one's wait
        // overlaps everybody else's, and their reads and writes share trips.
        const seenTo = await Promise.allSettled(
            owed.map(async ({ at, one: entrant }) => {
                if (!back.has(at) && !home.has(at)) return null;
                let one = entrant;
                const down = await stashService.settle(shared, one.name, (name) =>
                    stage.fallProof(name, 5)
                );
                let given = true;
                if (one.stash) {
                    if (!down) given = false;
                    else {
                        const how = await stashService.giveBack(
                            shared,
                            one.name,
                            one.stash,
                            async (kept) => {
                                one = { ...one, stash: kept };
                            }
                        );
                        given = how === "done" || how === "failed";
                    }
                }
                if (given && language && home.has(at))
                    await shared.say([
                        arena.tellTo(
                            one.name,
                            messages.tag(language) + messages.takenBack(language)
                        )
                    ]);
                return { one, given };
            })
        );
        // Whoever was seen to is written off as before; one that failed half
        // way is still owed everything, in what this answers.
        let failed: unknown = null;
        for (const [index, { at }] of owed.entries()) {
            const outcome = seenTo[index]!;
            if (outcome.status === "rejected") {
                failed ??= outcome.reason;
                continue;
            }
            const done = outcome.value;
            if (!done) continue;
            if (!done.given) remaining.push(done.one);
            handled.add(at);
        }
        if (failed !== null) throw failed;
        // The rules it held - keepInventory among them - put back only once
        // everybody who could be sent home is home and down.
        const owedRules = Object.entries(rules)
            .filter(([name, value]) => /^[A-Za-z:_]+$/.test(name) && /^(true|false)$/.test(value))
            .map(([name, value]) => commands.setRule(name, value));
        if (owedRules.length > 0) await server.sayAll(owedRules);
        rules = {};
        if (remaining.length > 0) {
            // Held up for them: closed and safe to log in to. Not kept loaded -
            // they load it themselves, arriving.
            await server.sayAll(releases(left));
            return { ...left, entrants: remaining, gamerules: {} };
        }
        if (left.arena) {
            await server.sayAll([
                arena.forceloadArea(left.arena.box, true),
                ...(left.marker ? [arena.killMarkedDrops(left.arena.box, left.marker)] : [])
            ]);
            // Whoever is still up there - somebody who walked in, a pet - floats down.
            await server.sayAll(stage.fallProofOver(left.arena.box));
            let whole = true;
            // Every kind of block in every slice of the box: hundreds of fills
            // for a SkyWars arena. Asked one at a time they held the podium back
            // for many seconds after the winner was known, so they go a paced
            // trip at a time (`pace.teardownPacer`), in order (`sayEach`); a
            // fill whose answer did not come back is asked again on its own,
            // never taken for done. A trip
            // that failed outright may still be running in the container, so
            // nothing is asked over it: the arena is tried again later.
            const lines = arena.teardown(left.arena);
            const pacing = pace.teardownPacer();
            for (let start = 0; start < lines.length; ) {
                const trip = pacing.take(lines.slice(start), pace.fillVolume);
                start += trip.length;
                let replies: (string | null)[] = [];
                if (server.sayEach) {
                    try {
                        const sayEach = server.sayEach;
                        replies = await pacing.timed(() => sayEach(trip.map((line) => [line])));
                    } catch (error) {
                        console.warn(
                            "polaris: an arena's teardown trip failed",
                            left.id,
                            String(error)
                        );
                        return { ...left, entrants: [], gamerules: {} };
                    }
                }
                for (const [at, line] of trip.entries()) {
                    const answer = replies[at] ?? (await server.say([line]));
                    if (arena.notLoaded(answer)) whole = false;
                }
            }
            // Its chunks were not in yet: kept loaded, and tried again.
            if (!whole) return { ...left, entrants: [], gamerules: {} };
        }
        await server.sayAll(releases(left));
        return null;
    } catch (error) {
        console.warn("polaris: taking an arena down failed", left.id, String(error));
        return {
            ...left,
            entrants: [...remaining, ...left.entrants.filter((_, at) => !handled.has(at))],
            gamerules: rules
        };
    }
}
