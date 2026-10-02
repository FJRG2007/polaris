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
import * as hill from "./hill";
import * as hillService from "./hill-service";
import * as stashService from "./stash-service";
import * as commands from "../commands";
import * as speech from "../../speech";
import * as written from "../messages";
import type * as stored from "../state";
import type { ServerContainer } from "../../service";
import type { PlaceRefusal } from "../place-search";

/** What players read, in one language or - given `speech.EVERY` - in every one. */
const messages = speech.spoken(written);

/** One line somebody said in the chat. */
export interface Said {
    readonly name: string;
    readonly text: string;
}

/** What the loop lends one of these events for a tick. */
export interface KindContext {
    readonly server: ServerContainer;
    /** Every language: each line is split for its readers on the way out. */
    readonly language: speech.Speech;
    /** The server's own: what is written once for everybody (the teams' names). */
    readonly home: catalog.Language;
    readonly now: number;
    /** The run as the loop holds it; set to change it. */
    run: stored.EventRun;
    persist(): Promise<void>;
    findPlace(
        place: catalog.EventPlace,
        distance: number,
        radius: number,
        /** `open` for what is built in the air, where open water under it will do. */
        surface?: "ground" | "open",
        /** Whether, after a few tries, it may come in closer and near a home. */
        nearHome?: boolean
    ): Promise<stored.Point | "failed" | null>;
    /** The place given up, for the reason given, and another looked for; throws
     *  once the tries run out. */
    giveUpPlace(point: stored.Point, why?: PlaceRefusal): Promise<void>;
    /** What was said since the last time this was asked; null the first time. */
    chat(): Promise<readonly Said[] | null>;
    atLeast(version: readonly number[]): Promise<boolean>;
    /** Who, in lower case, is still owed a trip back from an earlier arena. */
    owed(): Promise<ReadonlySet<string>>;
    /** Whose run a kept bag belongs to, for its database copy. */
    readonly stashOwner: stashService.StashOwner;
    /** How long one tick is, in seconds: what a second in the circle is counted by. */
    readonly tickSeconds: number;
}

/** The event cannot go on, for the reason given. */
export class EventStopped extends Error {}

/** Not enough players joined for it to go ahead: called off, which is nobody's
 *  failure - as a spleef with one player is. */
export class TooFew extends EventStopped {}

const NO_PLACE = "No dry ground was found for it near the players";
const ONE_SIDED = "Everybody left in it was on the same team";
/** Why it was called off, as the history keeps it (and `messages.cancelReason`
 *  says it to players). */
const tooFew = (joined: number, needed: number) => `Only ${joined} joined; it needs ${needed}`;
/** How far from the players the ground under an arena is looked for. */
const PLACE_DISTANCE = 32;
/** Ticks an arena's chunks are waited for before its site is given up. */
const LOAD_WAITS = 5;

/** What one run keeps in memory between ticks: nothing that must survive a restart. */
interface Memory {
    loadWaits: number;
    dealt: Map<string, number>;
    kills: Map<string, number>;
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
            loadWaits: 0,
            dealt: new Map(),
            kills: new Map(),
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
        if (!ctx.run.enrolled) await enroll(ctx, lines);
        else if (!ctx.run.arena) await raise(ctx);
        else await bringIn(ctx);
        return null;
    }
    if (ctx.run.preset.kind === "team-duel") await duelTick(ctx, lines);
    else if (ctx.run.preset.kind === "king-of-the-hill")
        await hillService.fightTick(ctx, ctx.tickSeconds, lines);
    else await buildTick(ctx, lines);
    return null;
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
    const most =
        ctx.run.preset.kind === "team-duel"
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
    const floorY = place.y + arena.ALTITUDE;
    return run.preset.kind === "team-duel"
        ? duel.duelBox(place, floorY)
        : build.platformBox(place, floorY, run.joined.length, plotSize(run));
}

function fillsFor(run: stored.EventRun, box: stored.Box): { box: stored.Box; block: string }[] {
    return run.preset.kind === "team-duel"
        ? duel.duelFills(box)
        : build.platformFills(box, run.joined.length, plotSize(run));
}

function blocksFor(run: stored.EventRun, fills: { block: string }[]): string[] {
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
    const run = ctx.run;
    const place = run.place;
    if (!place) {
        const reach =
            run.preset.kind === "team-duel"
                ? duel.DUEL_REACH
                : build.platformReach(run.joined.length, plotSize(run));
        const options = run.preset.options as { place: catalog.EventPlace };
        const found = await ctx.findPlace(options.place, PLACE_DISTANCE, reach, "open");
        if (found === "failed") throw new EventStopped(NO_PLACE);
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
    if (solid === 0 && waiting && memory.loadWaits < LOAD_WAITS) {
        memory.loadWaits += 1;
        return;
    }
    memory.loadWaits = 0;
    if (solid > 0 || waiting) {
        await giveUpSite(ctx, place, solid > 0 ? "occupied" : "unloaded");
        return;
    }
    // Nothing but air: ours to build in, and written down as ours before a
    // single block goes in.
    const fills = fillsFor(run, box);
    const built: stored.Arena = { box, blocks: blocksFor(run, fills) };
    ctx.run = { ...ctx.run, arena: built };
    await ctx.persist();
    await ctx.server.sayAll([
        ...fills.map((one) => arena.fillKeep(one.box, one.block)),
        commands.CLEAR_MARK
    ]);
    // A protected area refuses blocks without a word: what was asked for has
    // to be there, or it comes down again and another place is tried.
    const floor = fills.at(-1)!;
    const probe = `execute in minecraft:overworld if block ${floor.box.x1} ${floor.box.y1} ${floor.box.z1} ${floor.block}`;
    if (commands.readTest(await ctx.server.say([probe])) !== "passed") {
        await ctx.server.sayAll(arena.teardown(built));
        ctx.run = { ...ctx.run, arena: null };
        await giveUpSite(ctx, place, "refused");
    }
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
    const duelling = run.preset.kind === "team-duel";
    const hillside = run.preset.kind === "king-of-the-hill";
    const marker: stored.Marker = run.marker ?? (await kitMarker(ctx));
    // Nothing in the hands on the hill: fists only.
    const kit = duelling
        ? duel.duelKit((run.preset.options as catalog.EventOptions<"team-duel">).kit)
        : hillside
          ? []
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
                side: duelling ? index % 2 : index,
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
        duelling || hillside
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
    const counts = [0, 0];
    const linesIn = (one: stored.Entrant): string[] => {
        if (duelling) {
            const slot = counts[one.side] ?? 0;
            counts[one.side] = slot + 1;
            return [
                ...arena.enter(one.name, duel.sideSpot(box, one.side, slot)),
                duel.joinTeam(one.name, one.side),
                ...kit.map((id) => arena.giveMarked(one.name, id, 1, marker)),
                ...arena.titleTo(
                    one.name,
                    messages.duelEnterTitle(one.side, language),
                    messages.duelEnterSubtitle(
                        (options as catalog.EventOptions<"team-duel">).downHearts,
                        language
                    )
                )
            ];
        }
        if (hillside)
            return hillService.enterLines(ctx.run, one.name, one.side, overGround, language);
        return [
            ...arena.enter(
                one.name,
                build.plotSpot(
                    box,
                    one.side,
                    (options as catalog.EventOptions<"build-battle">).plotSize,
                    run.joined.length
                )
            ),
            ...build.kitCommands(one.name, marker),
            ...arena.titleTo(one.name, messages.themeTitle(language), `&f${theme ?? ""}`)
        ];
    };
    // One at a time: what they carry put away, and straight in - nobody left
    // standing about empty-handed at home, free to put their armor back on,
    // while everybody else's is put away.
    for (const one of [...ctx.run.entrants]) {
        if (!(await stashOne(ctx, one))) continue;
        await ctx.server.sayAll(linesIn(one));
    }
    // And once in, a last look: whatever turned up on them on the way is put
    // away with the rest; anybody it cannot be taken from is sent back out.
    for (const one of [...ctx.run.entrants]) await stashOne(ctx, one, true);
    // Too few left once those kept out are: called off, and everybody brought
    // in sent back with their things.
    const needed = catalog.joinersNeeded(run.preset);
    if (ctx.run.entrants.length < needed) throw new TooFew(tooFew(ctx.run.entrants.length, needed));
    // Everybody left on the one team: nobody to play against.
    if (duelling && [0, 1].some((side) => !ctx.run.entrants.some((one) => one.side === side)))
        throw new TooFew(ONE_SIDED);
    const out: string[] = [];
    if (theme !== null)
        out.push(commands.say(messages.tag(language) + messages.themeLine(theme, language)));
    out.push(commands.sound(commands.SOUNDS.start));
    await ctx.server.sayAll(out);
    const seconds =
        run.preset.minutes * 60 +
        (duelling || hillside
            ? 0
            : (run.preset.options as catalog.EventOptions<"build-battle">).voteSeconds);
    ctx.run = {
        ...ctx.run,
        readyAt: ctx.now,
        startsAt: ctx.now,
        endsAt: ctx.now + seconds * 1000
    };
    await ctx.persist();
}

/**
 * One player's own things put away before they are brought in and handed the
 * kit (`stash`), written into the run as it is kept - or, `inside`, what turned
 * up on them on the way in put away with the rest. From 1.17, which has `item`;
 * before it, the kit goes beside what they carry, as it always has. Answers
 * whether they are in: somebody whose things cannot all be put away is kept
 * out - told why, sent back where they were if they had been brought in, and
 * handed back whatever was taken.
 */
async function stashOne(ctx: KindContext, one: stored.Entrant, inside = false): Promise<boolean> {
    if (!one.away || (!inside && one.stash)) return true;
    if (!(await ctx.atLeast([1, 17]))) return true;
    // Written into the run as it is kept, and as it is given back.
    const keep = async (kept: stored.Entrant["stash"]) => {
        ctx.run = {
            ...ctx.run,
            entrants: ctx.run.entrants.map((each) =>
                each.name === one.name ? { ...each, stash: kept } : each
            )
        };
        await ctx.persist();
    };
    const result = await stashService.stashIn(
        ctx.server,
        ctx.stashOwner,
        one.name,
        keep,
        inside ? one.stash : null
    );
    if (!result.refused) return true;
    let entrant = ctx.run.entrants.find((each) => each.name === one.name) ?? one;
    ctx.run = {
        ...ctx.run,
        keptOut: await stashService.keepOut(
            ctx.server,
            ctx.run.keptOut,
            one.name,
            result.refused,
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
    const health = commands.readScores(await say(duel.READ_HP));
    const dealt = commands.readScores(await say(duel.READ_DEALT));
    const died = commands.readScores(await say(duel.READ_DIED));
    const kills = commands.readScores(await say(duel.READ_KILLS));
    const here = new Map(
        commands.readWhere(await say(commands.IN_OVERWORLD)).map((one) => [lower(one.name), one])
    );

    // Who struck and who killed since the last look; nothing on the first.
    const killsSince = new Map<string, number>();
    for (const [name, value] of kills) {
        const before = memory.kills.get(name);
        if (before !== undefined && value > before) killsSince.set(name, value - before);
        memory.kills.set(name, value);
    }
    for (const [name, value] of dealt) {
        const before = memory.dealt.get(name);
        if (before !== undefined && value > before) memory.lastHit.set(name, now);
        memory.dealt.set(name, value);
    }

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
            const by = duel.creditFor(rivals, killsSince, memory.lastHit, now);
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
    const counted =
        run.preset.kind === "build-battle"
            ? build.countVotes(run.votes)
            : new Map(Object.entries(run.points));
    const scores = new Map(run.entrants.map((one) => [one.name, counted.get(one.name) ?? 0]));
    return { scores, took: [...scores.keys()] };
}

export function standings(run: stored.EventRun): { name: string; score: number }[] {
    return [...arenaResults(run).scores.entries()]
        .map(([name, score]) => ({ name, score }))
        .sort((left, right) => right.score - left.score);
}

/** Said with the results: how the teams did, what the theme was. */
export function resultLines(run: stored.EventRun, language: speech.Speech): string[] {
    if (run.readyAt === null) return [];
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

/** Who is still owed a trip back, in lower case. */
export function owedNames(leftovers: readonly stored.ArenaLeftover[]): Set<string> {
    return new Set(
        leftovers.flatMap((one) =>
            one.entrants.filter((entrant) => entrant.away).map((entrant) => lower(entrant.name))
        )
    );
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
    let rules = left.gamerules;
    const remaining: stored.Entrant[] = [];
    let index = 0;
    try {
        const box = left.arena?.box ?? null;
        if (box && left.marker) await server.sayAll([arena.killMarkedDrops(box, left.marker)]);
        for (; index < left.entrants.length; index += 1) {
            let one = left.entrants[index]!;
            if (!one.away || !arena.commandable(one)) continue;
            // Their own things back only once they are home and down: nothing
            // is given back to a player who could still fall with it.
            const giveBack = async (): Promise<boolean> => {
                const down = await stashService.settle(server, one.name, (name) =>
                    stage.fallProof(name, 5)
                );
                if (!one.stash) return true;
                if (!down) return false;
                const how = await stashService.giveBack(
                    server,
                    one.name,
                    one.stash,
                    async (kept) => {
                        one = { ...one, stash: kept };
                    }
                );
                return how === "done" || how === "failed";
            };
            // Sent home already, by an end that stopped before it gave everything
            // back: not moved again, only given what they are still owed.
            const say = (line: string) => server.say([line]);
            if (one.tagged && (await commands.alreadyBack(say, one.name, arena.IN_ARENA))) {
                await server.sayAll(stage.fallProof(one.name));
                if (!(await giveBack())) remaining.push(one);
                continue;
            }
            // The kit off, unable to fall to their death, then home - with their
            // own game mode only there.
            await server.sayAll(arena.homeward(one, left.marker, left.kit));
            if (!arena.wentHome(await server.say([arena.sendHome(one)]))) {
                remaining.push(one);
                continue;
            }
            await server.sayAll([arena.homeMode(one), arena.leftArena(one.name)]);
            const thrown = box ? arena.sendThrown(box, one) : null;
            if (thrown) await server.say([thrown]);
            if (!(await giveBack())) {
                remaining.push(one);
                continue;
            }
            if (language) {
                await server.say([
                    arena.tellTo(one.name, messages.tag(language) + messages.takenBack(language))
                ]);
            }
        }
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
            for (const line of arena.teardown(left.arena)) {
                if (arena.notLoaded(await server.say([line]))) whole = false;
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
            entrants: [...remaining, ...left.entrants.slice(index)],
            gamerules: rules
        };
    }
}
