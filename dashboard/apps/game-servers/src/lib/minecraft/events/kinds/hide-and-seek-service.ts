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
 */

import * as hits from "./hits";
import * as arena from "./arena";
import * as hs from "./hide-and-seek";
import * as catalog from "../catalog";
import * as speech from "../../speech";
import * as written from "../messages";
import * as commands from "../commands";
import type * as stored from "../state";
import * as hitsService from "./hits-service";
import * as said from "./hide-and-seek-messages";
import type { ArenaGame, KindContext } from "./arena-game";

const messages = speech.spoken(written);
const seekMessages = speech.spoken(said);

const lower = (name: string) => name.toLowerCase();

function optionsOf(run: stored.EventRun): catalog.EventOptions<"hide-and-seek"> {
    return run.preset.options as catalog.EventOptions<"hide-and-seek">;
}

/** A run's hall, drawn once and kept: the search is not repeated every tick. */
const layouts = new Map<string, hs.Layout>();

function layoutOf(runId: string): hs.Layout {
    let layout = layouts.get(runId);
    if (!layout) {
        if (layouts.size >= 16) layouts.delete(layouts.keys().next().value!);
        layout = hs.layoutFor(runId);
        layouts.set(runId, layout);
    }
    return layout;
}

/** What one run keeps between ticks: nothing that must survive a restart. */
interface Memory {
    dealt: hits.Tally;
    taken: hits.Tally;
}

const memories = new Map<string, Memory>();

function memoryOf(runId: string): Memory {
    let memory = memories.get(runId);
    if (!memory) {
        if (memories.size >= 16) memories.delete(memories.keys().next().value!);
        memory = { dealt: hits.tally(), taken: hits.tally() };
        memories.set(runId, memory);
    }
    return memory;
}

/** Who seeks from the start: drawn from the run's id among who was brought in. */
function firstSeekers(run: stored.EventRun): string[] {
    return hs.seekersFor(
        run.id,
        run.entrants.map((one) => one.name),
        optionsOf(run).seekers
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
    if (design >= hs.DESIGN) return layoutOf(run.id);
    for (const test of hs.mirrorTests(run.arena!.box, design))
        if (commands.readTest(await ctx.server.say([test.line])) === "passed") return test.mirror;
    return layoutOf(run.id);
}

function spotOf(
    run: stored.EventRun,
    entrant: stored.Entrant,
    mirror: hs.Mirror = layoutOf(run.id)
): arena.Spot {
    const box = run.arena!.box;
    const design = designOf(run);
    const seekers = firstSeekers(run).map(lower);
    const at = seekers.indexOf(lower(entrant.name));
    if (at >= 0) return hs.seekerSpot(box, mirror, at, design);
    const hiders = run.entrants.filter((one) => !seekers.includes(lower(one.name)));
    return hs.hiderSpot(
        box,
        mirror,
        Math.max(
            0,
            hiders.findIndex((one) => one.name === entrant.name)
        ),
        design
    );
}

async function goLines(ctx: KindContext): Promise<string[]> {
    const run = ctx.run;
    const language = ctx.language;
    const seconds = optionsOf(run).hideSeconds;
    const seekers = firstSeekers(run).map(lower);
    const mirror = await mirrorOf(ctx);
    const out: string[] = [];
    for (const one of run.entrants) {
        const seeking = seekers.includes(lower(one.name));
        out.push(
            arena.moveTo(one.name, spotOf(run, one, mirror)),
            ...hs.joinSide(one.name, seeking),
            ...(seeking
                ? [
                      ...hs.waitingLines(one.name),
                      ...arena.titleTo(
                          one.name,
                          seekMessages.seekTitle(language),
                          seekMessages.seekSubtitle(seconds, language)
                      )
                  ]
                : arena.titleTo(
                      one.name,
                      seekMessages.hideTitle(language),
                      seekMessages.hideSubtitle(seconds, language)
                  ))
        );
    }
    return out;
}

async function tick(ctx: KindContext, lines: string[]): Promise<string | null> {
    const run = ctx.run;
    const language = ctx.language;
    const options = optionsOf(run);
    const box = run.arena!.box;
    const layout = layoutOf(run.id);
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
    const releaseAt = start + options.hideSeconds * 1000;

    // The seekers let out: the cage down, their sight and legs back.
    if (!state.released && now >= releaseAt) {
        state.released = true;
        lines.push(
            hs.cageDown(box, layout, state.design),
            ...state.seekers.flatMap(hs.releasedLines),
            ...arena.titleTo(`@a[tag=${arena.IN_ARENA}]`, seekMessages.releasedTitle(language), ""),
            commands.sound(commands.SOUNDS.horn)
        );
    }

    // Every hider on the server hidden for the time since the last look - at
    // most two ticks' worth, so a stall is not counted as hiding.
    const elapsed = Math.max(
        0,
        Math.min(now - (state.countedAt ?? start), 2 * ctx.tickSeconds * 1000)
    );
    state.countedAt = now;
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
                here.has(lower(one.name)) &&
                !hs.seeks(state, one.name) &&
                hurt.has(lower(one.name))
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
            const left = run.entrants.filter((each) => !hs.seeks(state, each.name)).length;
            lines.push(
                ...hs.joinSide(one.name, true),
                `effect clear ${one.name} minecraft:weakness`,
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
    for (const one of run.entrants) {
        const at = here.get(lower(one.name));
        if (!at) continue;
        const seeking = hs.seeks(state, one.name);
        lines.push(...hs.unhurtLines(one.name));
        if (!arena.contains(box, at)) lines.push(arena.moveTo(one.name, spotOf(run, one)));
        if (!seeking) lines.push(hs.hiderLine(one.name));
        else if (!state.released) lines.push(...hs.waitingLines(one.name));
        lines.push(
            arena.actionbarTo(
                one.name,
                !seeking
                    ? seekMessages.hiddenBar(
                          (state.hidden[one.name] ?? 0) / 1000,
                          hiders.length,
                          language
                      )
                    : state.released
                      ? seekMessages.seekBar(hiders.length, language)
                      : seekMessages.waitBar((releaseAt - now) / 1000, language)
            )
        );
    }
    lines.push(
        `bossbar set ${commands.BAR} name ${commands.text(
            seekMessages.bar(hiders.length, messages.clock((run.endsAt - now) / 1000), language)
        )}`,
        ...arena.keepThrown(box)
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

export const hideAndSeek: ArenaGame = {
    most: () => hs.MOST,
    reach: () => hs.REACH,
    box: (_run, place) => hs.hallBox(place, place.y + arena.ALTITUDE),
    built: () => ({ design: hs.DESIGN }),
    fills: (run, box) => hs.hallFills(box, layoutOf(run.id)),
    blocks: () => [...hs.HALL_BLOCKS],
    kit: () => [],
    hits: true,
    side: (_run, index) => index,
    spot: (run, entrant) => spotOf(run, entrant),
    beginLines: (_preset, language) => hs.setupLines(said.teamNames(language)),
    goLines,
    tick,
    results: (run) =>
        hs.scoresOf(
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
    endLines: () => [...hs.TEARDOWN]
};
