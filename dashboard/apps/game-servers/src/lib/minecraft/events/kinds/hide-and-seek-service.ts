/**
 * Playing hide and seek (`hide-and-seek.ts`): the arena's own steps are
 * `arena-service`'s; this is its part of them.
 *
 * At "Go!" the seekers drawn from the run's id are put in the cage, blinded and
 * unable to walk, and everybody else round it to run and hide. Each tick then
 * adds the time since the last to every hider on the server, lets the seekers
 * out once `hideSeconds` are up - the cage's barrier taken down, only in its own
 * box - and after that reads who struck and who was hurt: a hider hurt beside a
 * seeker who struck is found, and seeks from then on. Everything is written into
 * the run as it happens, the release included, so a restart neither lets the
 * seekers out early nor builds the cage again.
 *
 * A house built by design 3 has secret rooms: at "Go!" their doors are put to
 * work by the events data pack (`secret-doors.ts`), and at the end they are
 * stopped and left open before anybody is sent home; the arena's own close
 * takes their markers away again before the house comes down.
 */

import * as hits from "./hits";
import * as arena from "./arena";
import * as hs from "./hide-and-seek";
import { radarLine } from "./radar";
import * as manor from "./seek-manor";
import * as model from "./seek-grid";
import * as catalog from "../catalog";
import * as speech from "../../speech";
import * as written from "../messages";
import * as commands from "../commands";
import type * as stored from "../state";
import * as hitsService from "./hits-service";
import * as build from "./build-battle";
import * as said from "./hide-and-seek-messages";
import type { ArenaGame, KindContext } from "./arena-game";

const messages = speech.spoken(written);
const seekMessages = speech.spoken(said);

const lower = (name: string) => name.toLowerCase();

function optionsOf(run: stored.EventRun): catalog.EventOptions<"hide-and-seek"> {
    return run.preset.options as catalog.EventOptions<"hide-and-seek">;
}

/** A run's hall, drawn once and kept: the search is not repeated every tick.
 *  Drawn by the design that built it, so a hall built before an update is the
 *  one the run still plays in. */
const layouts = new Map<string, hs.Layout>();

function layoutOf(runId: string, design = hs.DESIGN): hs.Layout {
    const key = `${runId}:${design}`;
    let layout = layouts.get(key);
    if (!layout) {
        if (layouts.size >= 16) layouts.delete(layouts.keys().next().value!);
        layout = hs.layoutFor(runId, design);
        layouts.set(key, layout);
    }
    return layout;
}

/** A run's manor (design 4 on), drawn once and kept, by what it was built
 *  for: its rooms along a side and what the server could show. */
const manors = new Map<string, manor.Manor>();

function gameOf(run: stored.EventRun): Partial<hs.SeekState> {
    const parsed = hs.stateSchema.partial().safeParse(run.game ?? {});
    return parsed.success ? parsed.data : {};
}

/** Rooms along a side: as built, or - before it is - as it will be. */
function roomsOf(run: stored.EventRun): number {
    const game = gameOf(run);
    if (game.rooms) return game.rooms;
    if (run.arena) return manor.countOf(run.arena.box);
    return manor.roomsFor(run.joined.length, optionsOf(run).house);
}

function manorOf(run: stored.EventRun): manor.Manor {
    const rooms = roomsOf(run);
    const era = gameOf(run).era ?? model.OLDEST;
    const design = designOf(run);
    const key = `${run.id}:${design}:${rooms}:${era.scaffold}:${era.snow}:${era.display}`;
    let built = manors.get(key);
    if (!built) {
        if (manors.size >= 8) manors.delete(manors.keys().next().value!);
        built = manor.manorFor(run.id, rooms, era, design);
        manors.set(key, built);
    }
    return built;
}

/** Whether a run plays in a manor. */
function inManor(run: stored.EventRun): boolean {
    return designOf(run) >= manor.FIRST;
}

/** What one run keeps between ticks: nothing that must survive a restart. */
interface Memory {
    dealt: hits.Tally;
    taken: hits.Tally;
    /** Who was on the server at the last look: whoever was not is told the
     *  radar code again, since a minimap forgets it on a fresh join. */
    seen: Set<string>;
}

const memories = new Map<string, Memory>();

function memoryOf(runId: string): Memory {
    let memory = memories.get(runId);
    if (!memory) {
        if (memories.size >= 16) memories.delete(memories.keys().next().value!);
        memory = { dealt: hits.tally(), taken: hits.tally(), seen: new Set() };
        memories.set(runId, memory);
    }
    return memory;
}

/** Who seeks from the start: drawn from the run's id among who was brought in,
 *  not whoever sought first last time when there are others. */
export function firstSeekers(run: stored.EventRun): string[] {
    return hs.seekersFor(
        run.id,
        run.entrants.map((one) => one.name),
        optionsOf(run).seekers,
        run.seekersBefore
    );
}

/** The design that built a run's hall, as written into it then. */
function designOf(run: stored.EventRun): number {
    return hs.stateSchema.shape.design
        .catch(hs.DESIGN)
        .parse((run.game as { design?: unknown } | null)?.design);
}

/**
 * Which way a run's hall is mirrored: its layout's, or - built by an older
 * design, whose layout is not drawn any more - read back from the world.
 */
async function mirrorOf(ctx: KindContext): Promise<hs.Mirror> {
    const run = ctx.run;
    const design = designOf(run);
    if (design >= manor.FIRST) return { flipX: false, flipZ: false };
    if (design >= hs.HOUSE) return layoutOf(run.id, design);
    for (const test of hs.mirrorTests(run.arena!.box, design))
        if (commands.readTest(await ctx.server.say([test.line])) === "passed") return test.mirror;
    return layoutOf(run.id);
}

function spotOf(
    run: stored.EventRun,
    entrant: stored.Entrant,
    mirror: hs.Mirror = inManor(run)
        ? { flipX: false, flipZ: false }
        : layoutOf(run.id, designOf(run))
): arena.Spot {
    const box = run.arena!.box;
    const design = designOf(run);
    const seekers = firstSeekers(run).map(lower);
    const at = seekers.indexOf(lower(entrant.name));
    const hiders = run.entrants.filter((one) => !seekers.includes(lower(one.name)));
    const index = Math.max(
        0,
        hiders.findIndex((one) => one.name === entrant.name)
    );
    if (design >= manor.FIRST) {
        const house = manorOf(run);
        return at >= 0 ? manor.seekerSpot(box, house, at) : manor.hiderSpot(box, house, index);
    }
    if (at >= 0) return hs.seekerSpot(box, mirror, at, design);
    return hs.hiderSpot(box, mirror, index, design);
}

/** Every minimap radar off for one player, and why. */
function radarOff(name: string): string {
    return radarLine(name, hs.RADAR_OFF, said.radarOff);
}

async function goLines(ctx: KindContext): Promise<string[]> {
    const run = ctx.run;
    const language = ctx.language;
    const seconds = optionsOf(run).hideSeconds;
    const seekers = firstSeekers(run).map(lower);
    const mirror = await mirrorOf(ctx);
    // No hit from before "Go!" - or from another arena's fight - read as a find.
    const out: string[] = [...hits.TAGS_OFF];
    // The secret doors worked by the pack, where it is on: elsewhere they stay
    // open as they were built, still a way in.
    const design = designOf(run);
    const house = design >= manor.FIRST ? manorOf(run) : null;
    const layout = !house && design >= hs.HOUSE ? layoutOf(run.id, design) : null;
    const packOn = house ? await hitsService.ensure(ctx) : false;
    if (house)
        out.push(
            ...(packOn
                ? manor.armLines(run.arena!.box, house, run.id)
                : manor.openLines(run.arena!.box, house)),
            `tellraw @a[tag=${arena.IN_ARENA}] ${commands.text(
                messages.tag(language) +
                    seekMessages.manorTip(language, packOn, house.pads.length > 0)
            )}`
        );
    if (layout && (await hitsService.ensure(ctx)))
        out.push(...hs.doorLines(run.arena!.box, layout));
    // Where else to look, in a house that has more than the floor.
    if (layout && hs.hidingPlaces(layout).secret > 0)
        out.push(
            `tellraw @a[tag=${arena.IN_ARENA}] ${commands.text(
                messages.tag(language) + seekMessages.secretTip(language)
            )}`
        );
    const memory = memoryOf(run.id);
    for (const one of run.entrants) {
        const seeking = seekers.includes(lower(one.name));
        memory.seen.add(lower(one.name));
        out.push(
            arena.moveTo(one.name, spotOf(run, one, mirror)),
            radarOff(one.name),
            ...hs.joinSide(one.name, seeking),
            ...(seeking
                ? [
                      ...hs.waitingLines(one.name, seconds),
                      ...arena.titleTo(
                          one.name,
                          seekMessages.seekTitle(language),
                          seekMessages.seekSubtitle(seconds, language)
                      )
                  ]
                : [
                      ...arena.titleTo(
                          one.name,
                          seekMessages.hideTitle(language),
                          seekMessages.hideSubtitle(seconds, language)
                      ),
                      ...(house ? hs.fireproofLines(one.name) : [])
                  ])
        );
    }
    return out;
}

async function tick(ctx: KindContext, lines: string[]): Promise<string | null> {
    const run = ctx.run;
    const language = ctx.language;
    const options = optionsOf(run);
    const box = run.arena!.box;
    const house = inManor(run) ? manorOf(run) : null;
    const layout = house ? null : layoutOf(run.id, designOf(run));
    const now = ctx.now;
    const memory = memoryOf(run.id);
    const say = (line: string) => ctx.server.say([line]);
    const here = new Map(
        commands.readWhere(await say(commands.IN_OVERWORLD)).map((one) => [lower(one.name), one])
    );
    // Who struck and who was hurt since the last look: the pack's, or else what
    // the damage counts say - nothing on the first look after a restart.
    const taken = await hitsService.take(ctx);
    const on = new Set(here.keys());
    // Back on the server: the radar code again, for a minimap that forgot it.
    const back = run.entrants.filter(
        (one) => on.has(lower(one.name)) && !memory.seen.has(lower(one.name))
    );
    for (const one of back) lines.push(radarOff(one.name));
    memory.seen = on;
    const struck =
        taken?.struck ??
        hits.roseFor(memory.dealt, commands.readScores(await say(hs.READ_DEALT)), on);
    const hurt =
        taken?.hurt ??
        hits.roseFor(memory.taken, commands.readScores(await say(hs.READ_TAKEN)), on);

    const before = hs.stateOf(run.game);
    const start = run.readyAt ?? now;
    const state: hs.SeekState = structuredClone(
        before ??
            hs.stateSchema.parse({
                ...(run.game ?? {}),
                seekers: firstSeekers(run),
                countedAt: start
            })
    );
    const planned = start + options.hideSeconds * 1000;
    if (!state.released && state.allReadyAt === null && now < planned)
        readyTick(ctx, state, here, planned, lines, await ctx.chat());
    const releaseAt = state.allReadyAt ?? planned;

    // A seeker who was away when the cage came down: their sight and legs back.
    if (state.released) {
        const seeking = new Set(state.seekers.map(lower));
        for (const one of back)
            if (seeking.has(lower(one.name))) lines.push(...hs.releasedLines(one.name));
    }

    // The seekers let out: the cage down, their sight and legs back.
    if (!state.released && now >= releaseAt) {
        state.released = true;
        lines.push(
            house ? manor.cageDown(box, house) : hs.cageDown(box, layout!, state.design),
            ...state.seekers.flatMap(hs.releasedLines),
            ...arena.titleTo(`@a[tag=${arena.IN_ARENA}]`, seekMessages.releasedTitle(language), ""),
            commands.sound(commands.SOUNDS.horn)
        );
    }

    // Every hider on the server hidden for the time since the last look - at
    // most two ticks' worth, so a stall is not counted as hiding - once the
    // seekers are out: the time to hide is everybody's, and worth nothing.
    const elapsed = Math.max(
        0,
        Math.min(now - Math.max(state.countedAt ?? start, releaseAt), 2 * ctx.tickSeconds * 1000)
    );
    state.countedAt = now;
    if (state.released)
        for (const one of run.entrants)
            if (!hs.seeks(state, one.name) && here.has(lower(one.name)))
                state.hidden[one.name] = (state.hidden[one.name] ?? 0) + elapsed;

    // Found: a hider hurt by a seeker - the one the game says, or else beside
    // a seeker who struck.
    if (state.released) {
        const seeking = run.entrants.filter((one) => hs.seeks(state, one.name));
        const strikers = seeking
            .filter((one) => struck.has(lower(one.name)) && here.has(lower(one.name)))
            .map((one) => ({ ...here.get(lower(one.name))!, name: one.name }));
        const hurtHiders = run.entrants.filter(
            (one) =>
                here.has(lower(one.name)) && !hs.seeks(state, one.name) && hurt.has(lower(one.name))
        );
        const attackers = await hitsService.attackers(
            ctx,
            hurtHiders.map((one) => one.name)
        );
        for (const one of hurtHiders) {
            const at = here.get(lower(one.name))!;
            const by = hs.foundBy(
                at,
                strikers,
                attackers.get(lower(one.name)),
                seeking.map((each) => each.name)
            );
            if (!by) continue;
            state.finds.push({ hider: one.name, by, at: now });
            delete state.powers[one.name];
            const left = run.entrants.filter((each) => !hs.seeks(state, each.name)).length;
            lines.push(
                ...hs.joinSide(one.name, true),
                `effect clear ${one.name} minecraft:weakness`,
                ...hs.effectsOff(one.name),
                ...arena.titleTo(
                    one.name,
                    seekMessages.foundTitle(language),
                    seekMessages.foundSubtitle(language)
                ),
                commands.say(
                    messages.tag(language) + seekMessages.found(one.name, by, left, language)
                ),
                commands.sound(commands.SOUNDS.tick)
            );
        }
    }

    // Nobody hurt; hiders unable to strike; seekers waiting kept in the cage,
    // blind; anybody out of the hall back on their spot.
    const hiders = run.entrants.filter((one) => !hs.seeks(state, one.name));
    // Power-ups: every few minutes once the seekers are out, one short boost
    // for each hider on the server, drawn from the run's id.
    const every = options.powerUpMinutes * 60_000;
    if (state.released && every > 0) {
        state.powerAt ??= releaseAt + every;
        if (now >= state.powerAt) {
            const round = Math.round((state.powerAt - releaseAt) / every);
            for (const one of hiders) {
                if (!here.has(lower(one.name))) continue;
                const power = hs.powerFor(run.id, one.name, round);
                lines.push(...hs.powerLines(one.name, power));
                state.powers[one.name] = {
                    kind: power,
                    until: now + hs.POWER_SECONDS[power] * 1000
                };
            }
            state.powerAt += every * Math.max(1, Math.ceil((now - state.powerAt + 1) / every));
        }
    }
    // A call from every hider still hidden, now and then, heard from a few
    // blocks off them: roughly where to look, never the spot.
    const due = state.released
        ? hs.nextReveal(options.revealSeconds, releaseAt, state.revealedAt, ctx.run.endsAt)
        : null;
    if (due !== null && now >= due) {
        state.reveals += 1;
        state.revealedAt = now;
        for (const one of hiders) {
            const at = here.get(lower(one.name));
            if (!at) continue;
            lines.push(
                ...hs.revealLines(
                    hs.revealPoint(run.id, one.name, state.reveals, at),
                    arena.IN_ARENA
                ),
                arena.tellTo(one.name, messages.tag(language) + seekMessages.revealTold(language))
            );
        }
    }
    // The manor's lava: everybody crosses it unhurt, so a seeker can look
    // wherever a hider can hide. The same pack freezes a seeker a potion
    // reaches.
    const packOn = house ? await hitsService.ensure(ctx) : false;
    // The freeze potions, once a game, to hiders on the server: only where
    // the pack can freeze, and only for a run that took them in its kit, so
    // the end takes them back.
    if (
        state.released &&
        packOn &&
        options.freezePotions > 0 &&
        state.freezeGiven.length === 0 &&
        run.marker &&
        run.kit.includes(hs.FREEZE_ITEM)
    ) {
        state.freezeAt ??= hs.freezeAt(run.id, releaseAt, ctx.run.endsAt);
        const holders =
            state.freezeAt !== null && now >= state.freezeAt
                ? hs.freezeHolders(
                      run.id,
                      hiders.map((one) => one.name).filter((name) => here.has(lower(name))),
                      options.freezePotions
                  )
                : [];
        if (holders.length > 0) {
            state.freezeGiven = holders;
            lines.push(
                ...hs.freezeArmLines(options.freezeSeconds),
                ...holders.map((name) =>
                    arena.giveMarked(name, hs.FREEZE_ITEM, 1, run.marker!, hs.FREEZE_EXTRAS)
                ),
                ...holders.map((name) =>
                    arena.tellTo(
                        name,
                        messages.tag(language) +
                            seekMessages.freezeTold(options.freezeSeconds, language)
                    )
                ),
                commands.say(
                    messages.tag(language) + seekMessages.freezeAnnounced(holders.length, language)
                )
            );
        }
    }
    for (const one of run.entrants) {
        const at = here.get(lower(one.name));
        if (!at) continue;
        const seeking = hs.seeks(state, one.name);
        lines.push(...hs.unhurtLines(one.name));
        if (!arena.contains(box, at)) lines.push(arena.moveTo(one.name, spotOf(run, one)));
        if (house) lines.push(...hs.fireproofLines(one.name));
        if (!seeking) lines.push(hs.hiderLine(one.name));
        else if (!state.released)
            lines.push(...hs.waitingLines(one.name, (releaseAt - now) / 1000));
        const power = !seeking ? state.powers[one.name] : undefined;
        const boost =
            power && power.until > now
                ? ` ${seekMessages.powerBar(power.kind, (power.until - now) / 1000, language)}`
                : "";
        lines.push(
            arena.actionbarTo(
                one.name,
                !seeking
                    ? (state.released
                          ? seekMessages.hiddenBar(
                                (state.hidden[one.name] ?? 0) / 1000,
                                hiders.length,
                                language
                            )
                          : seekMessages.hideBar(
                                (releaseAt - now) / 1000,
                                readyHere(run, state, here),
                                hidersHere(run, state, here).length,
                                language
                            )) + boost
                    : state.released
                      ? seekMessages.seekBar(hiders.length, language)
                      : seekMessages.waitBar((releaseAt - now) / 1000, language)
            )
        );
    }
    lines.push(
        // One countdown for everybody: the time left to hide, then the time
        // left in the game.
        `bossbar set ${commands.BAR} name ${commands.text(
            state.released
                ? seekMessages.bar(
                      hiders.length,
                      messages.clock((ctx.run.endsAt - now) / 1000),
                      language
                  )
                : seekMessages.hidingBar(messages.clock((releaseAt - now) / 1000), language)
        )}`,
        ...arena.keepThrown(box),
        // Anything the house itself let fall - a block a seeker knocked loose -
        // gone before somebody picks it up and takes it home with them.
        ...(run.marker ? [arena.killBrokenDrops(box, run.marker)] : [])
    );
    const scores = hs.scoresOf(
        state,
        run.entrants.map((one) => one.name)
    );
    // The side panel, where a score changed.
    for (const [name, score] of scores)
        if (run.points[name] !== score) lines.push(commands.setScore(name, score));
    ctx.run = { ...ctx.run, game: state, points: Object.fromEntries(scores) };
    await ctx.persist();
    return hiders.length === 0 ? said.ALL_FOUND : null;
}

/** This run's hiders on the server, by their names as they joined. */
function hidersHere(
    run: stored.EventRun,
    state: hs.SeekState,
    here: ReadonlyMap<string, unknown>
): string[] {
    return run.entrants
        .map((one) => one.name)
        .filter((name) => !hs.seeks(state, name) && here.has(lower(name)));
}

/** How many of this run's hiders on the server are ready. */
function readyHere(
    run: stored.EventRun,
    state: hs.SeekState,
    here: ReadonlyMap<string, unknown>
): number {
    const ready = new Set(state.ready.map(lower));
    return hidersHere(run, state, here).filter((name) => ready.has(lower(name))).length;
}

/**
 * The [Ready] button while the seekers wait, the build battle's [Done] by
 * another name: offered to each hider once, read with the join buttons'
 * trigger (or typed `done` / `undo`), taken back with [Not yet] until every
 * hider on the server is ready. Then the rest of the time to hide is skipped
 * - the seekers come out now, and the run ends as much earlier, so the time to
 * seek is the same - and that is written down, so nobody can take it back.
 */
function readyTick(
    ctx: KindContext,
    state: hs.SeekState,
    here: ReadonlyMap<string, unknown>,
    planned: number,
    lines: string[],
    chat: readonly { name: string; text: string }[] | null
): void {
    const language = ctx.language;
    const tag = messages.tag(language);
    const hiders = new Map(
        ctx.run.entrants
            .filter((one) => !hs.seeks(state, one.name))
            .map((one) => [lower(one.name), one.name])
    );
    const offer = (lead: string, name: string) =>
        commands.buttonsLine(name, tag + lead, [
            {
                ...seekMessages.readyOffer(language).ready,
                color: "green",
                value: commands.DONE_VALUE
            }
        ]);
    if (!state.readyOffered) {
        lines.push(...commands.joinTriggerLines());
        for (const name of hiders.values())
            lines.push(offer(seekMessages.readyOffer(language).lead, name));
        state.readyOffered = true;
    }
    for (const said of chat ?? []) {
        const name = hiders.get(lower(said.name));
        const word = build.readDone(said.text);
        if (!name || !word) continue;
        const marked = state.ready.some((one) => lower(one) === lower(name));
        if (word === "done" && !marked) {
            state.ready = [...state.ready, name];
            const back = seekMessages.readyMarked(language);
            lines.push(
                commands.buttonsLine(name, tag + back.lead, [
                    { ...back.undo, color: "gray", value: commands.UNDO_VALUE }
                ])
            );
        } else if (word === "undo" && marked) {
            state.ready = state.ready.filter((one) => lower(one) !== lower(name));
            lines.push(offer(seekMessages.readyUndone(language), name));
        }
    }
    if (!build.everybodyDone([...hiders.values()], new Set(here.keys()), state.ready)) return;
    state.allReadyAt = ctx.now;
    ctx.run = { ...ctx.run, endsAt: ctx.run.endsAt - Math.max(0, planned - ctx.now) };
    lines.push(commands.say(tag + seekMessages.allReady(language)));
}

/** What the server can show, asked once before the house is built. */
async function prepare(ctx: KindContext): Promise<Record<string, unknown>> {
    const era: model.Era = {
        scaffold: await ctx.atLeast([1, 14]),
        snow: await ctx.atLeast([1, 17]),
        display: await ctx.atLeast([1, 19, 4])
    };
    return {
        design: manor.DESIGN,
        era,
        rooms: manor.roomsFor(ctx.run.joined.length, optionsOf(ctx.run).house)
    };
}

export const hideAndSeek: ArenaGame = {
    most: () => manor.MOST,
    reach: (run) => manor.reachOf(roomsOf(run)),
    box: (run, place) => manor.hallBox(place, place.y + arena.ALTITUDE, roomsOf(run)),
    prepare,
    built: (run) => ({
        design: gameOf(run).design ?? manor.DESIGN,
        era: gameOf(run).era ?? model.OLDEST,
        rooms: roomsOf(run)
    }),
    fills: (run, box) => manor.manorFills(box, manorOf(run)),
    blocks: (run) => manor.manorBlocks(manorOf(run)),
    decorate: (run, box) => manor.decorLines(box, manorOf(run)),
    // The freeze potion, when the game hands any out: marked, so the end
    // takes it back from whoever still has it.
    kit: (run) => ((optionsOf(run).freezePotions ?? 0) > 0 ? [hs.FREEZE_ITEM] : []),
    hits: true,
    side: (_run, index) => index,
    spot: (run, entrant) => spotOf(run, entrant),
    beginLines: (_preset, language) => hs.setupLines(said.teamNames(language)),
    goLines,
    tick,
    // Swept on the quick look as well as the tick: an item lies half a second
    // before it can be picked up, and the tick comes round every two. Picked
    // up, it went home with them and took a slot their own things came back to.
    quickLines: (run) => (run.marker ? [arena.killBrokenDrops(run.arena!.box, run.marker)] : []),
    results: (run) =>
        hs.scoresOf(
            hs.stateOf(run.game),
            run.entrants.map((one) => one.name)
        ),
    tiebreak: (run) =>
        hs.tiebreakOf(
            hs.stateOf(run.game),
            run.entrants.map((one) => one.name)
        ),
    resultLines: (run, language) => {
        const state = hs.stateOf(run.game);
        if (!state) return [];
        const seekers = new Set(state.seekers.map(lower));
        const hiders = run.entrants.filter((one) => !seekers.has(lower(one.name))).length;
        return [commands.say(seekMessages.summary(state.finds.length, hiders, language))];
    },
    // The secret doors stopped and open, so nobody is left shut in; every
    // entrant's minimap given back what the server allows.
    endLines: (run) => [
        ...(run.arena ? hs.doorsOff(run.arena.box) : []),
        ...hs.effectsOff(),
        ...hs.TEARDOWN,
        ...run.entrants.map((one) => radarLine(one.name, hs.RADAR_RESET))
    ],
    // Nothing works the doors once the house is coming down, for a run that
    // never reached its end too.
    closeLines: (box) => [...hs.doorsStill(box), ...manor.closeLines(box), ...hs.effectsOff()],
    // Not on at the end: the radar and what the game gave them are taken off when they are next.
    owedLines: (_run, name) => [
        { reason: "radar", lines: [radarLine(name, hs.RADAR_RESET)] },
        { reason: "effects", lines: hs.effectsOff(name) },
        { reason: "seek-sides", lines: hs.sideTagsOff(name) }
    ]
};
