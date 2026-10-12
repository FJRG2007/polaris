/**
 * Playing tug of war (`tug-of-war.ts`): the arena's own steps are
 * `arena-service`'s; this is its part of them.
 *
 * Each tick reads where everybody is and the game's own count of each rod's
 * uses, takes how much each count rose since the last look (`hits.rose`: none
 * on the first look after a restart), caps it (`tug.countPulls`) and moves the
 * marker by the two teams' averages. Anybody out of their pen is put back and
 * counts nothing that look. Once a team has won, the losers' floor opens and
 * the run is given `FALL_MS` for them to land in the pool before it ends.
 */

import * as hits from "./hits";
import * as arena from "./arena";
import * as duel from "./team-duel";
import * as tug from "./tug-of-war";
import * as catalog from "../catalog";
import * as speech from "../../speech";
import * as written from "../messages";
import * as commands from "../commands";
import type * as stored from "../state";
import * as said from "./tug-of-war-messages";
import type { ArenaGame, KindContext } from "./arena-game";

const messages = speech.spoken(written);
const tugMessages = speech.spoken(said);

const lower = (name: string) => name.toLowerCase();

function lengthOf(run: stored.EventRun): number {
    return (
        (run.preset.options as catalog.EventOptions<"tug-of-war">).ropeLength ?? tug.DEFAULT_LENGTH
    );
}

/** What one run keeps between ticks: nothing that must survive a restart. */
interface Memory {
    pulls: hits.Tally;
    lastAt: number | null;
}

const memories = new Map<string, Memory>();

function memoryOf(runId: string): Memory {
    let memory = memories.get(runId);
    if (!memory) {
        // Only a few runs are ever on at once, one a server.
        if (memories.size >= 16) memories.delete(memories.keys().next().value!);
        memory = { pulls: hits.tally(), lastAt: null };
        memories.set(runId, memory);
    }
    return memory;
}

/** Where an entrant stands: their side's pen, in the order they came in. */
function spotOf(run: stored.EventRun, entrant: stored.Entrant): arena.Spot {
    const slot = run.entrants
        .slice(
            0,
            Math.max(
                0,
                run.entrants.findIndex((one) => one.name === entrant.name)
            )
        )
        .filter((one) => one.side === entrant.side).length;
    return tug.startSpot(run.arena!.box, lengthOf(run), entrant.side, slot);
}

async function goLines(ctx: KindContext, syntax: { marker: stored.Marker }) {
    const run = ctx.run;
    const out: string[] = [];
    for (const one of run.entrants)
        out.push(
            arena.moveTo(one.name, spotOf(run, one)),
            arena.giveMarked(one.name, tug.ROD, 1, syntax.marker, arena.LASTS),
            ...arena.titleTo(
                one.name,
                messages.duelEnterTitle(one.side, ctx.language),
                tugMessages.enterSubtitle(ctx.language)
            )
        );
    return out;
}

async function tick(ctx: KindContext, lines: string[]): Promise<string | null> {
    const run = ctx.run;
    const language = ctx.language;
    const box = run.arena!.box;
    const length = lengthOf(run);
    const memory = memoryOf(run.id);
    const now = ctx.now;
    const everybody = `@a[tag=${arena.IN_ARENA}]`;
    const before = tug.stateOf(run.game);
    const left = Math.max(0, (run.endsAt - now) / 1000);
    for (const one of run.entrants) lines.push(arena.feed(one.name), arena.protect(one.name));

    // Decided: the losers are falling into the pool; over once they are in.
    if (before.wonBy !== null) {
        if (now - (before.wonAt ?? now) >= tug.FALL_MS)
            return said.wonBy(before.wonBy, before.timeUp);
        return null;
    }

    const say = (line: string) => ctx.server.say([line]);
    const here = new Map(
        commands.readWhere(await say(commands.IN_OVERWORLD)).map((one) => [lower(one.name), one])
    );
    const scores = commands.readScores(await say(tug.READ_PULLS));
    const risen = hits.rose(memory.pulls, scores, new Set(here.keys()));
    const elapsed = memory.lastAt === null ? 0 : (now - memory.lastAt) / 1000;
    memory.lastAt = now;
    const counted = tug.countPulls(risen, elapsed);

    const points = { ...run.points };
    const sides: number[][] = [[], []];
    for (const one of run.entrants) {
        const at = here.get(lower(one.name));
        if (!at) continue;
        if (!tug.inPen(box, length, one.side, at)) {
            lines.push(arena.moveTo(one.name, spotOf(run, one)));
            sides[one.side]!.push(0);
            continue;
        }
        const pulled = counted.get(lower(one.name)) ?? 0;
        sides[one.side]!.push(pulled);
        if (pulled > 0) {
            points[one.name] = (points[one.name] ?? 0) + pulled;
            lines.push(commands.setScore(one.name, points[one.name]!));
        }
        lines.push(
            arena.actionbarTo(
                one.name,
                tugMessages.statusBar(one.side, points[one.name] ?? 0, language)
            )
        );
    }

    const position = tug.move(
        before.position,
        tug.teamPull(sides[0]!),
        tug.teamPull(sides[1]!),
        length
    );
    let state: tug.TugState = { ...before, position };
    let winner = tug.crossed(position, length);
    let timeUp = false;
    // The time all but up: whoever is ahead wins, with the time left to drop.
    if (winner === null && now >= run.endsAt - tug.FALL_MS) {
        winner = tug.leader(position);
        timeUp = winner !== null;
    }
    lines.push(
        ...tug.markerLines(box, length, position),
        `bossbar set ${commands.BAR} name ${commands.text(tugMessages.bar(position, length, left, language))}`
    );
    if (winner !== null) {
        state = { ...state, wonBy: winner, wonAt: now, timeUp };
        lines.push(
            ...tug.openLines(box, length, 1 - winner),
            commands.say(messages.tag(language) + tugMessages.won(winner, timeUp, language)),
            ...arena.titleTo(
                everybody,
                tugMessages.wonTitle(winner, language),
                tugMessages.wonSubtitle(language)
            ),
            commands.sound(commands.SOUNDS.win)
        );
    }

    const moved =
        Math.round(position) !== Math.round(before.position) || state.wonBy !== before.wonBy;
    ctx.run = { ...ctx.run, game: state, points };
    if (moved) await ctx.persist();
    return null;
}

export const tugOfWar: ArenaGame = {
    most: () => tug.MOST,
    reach: (run) => tug.reachOf(lengthOf(run)),
    box: (run, place) => tug.arenaBox(place, place.y + arena.ALTITUDE, lengthOf(run)),
    built: () => ({ design: tug.DESIGN }),
    fills: (run, box) => tug.arenaFills(box, lengthOf(run)),
    decorSpots: (run, box) => tug.decorSpots(box, lengthOf(run)),
    blocks: () => [...tug.ARENA_BLOCKS],
    kit: () => [tug.ROD],
    teams: 2,
    side: (_run, index) => index % 2,
    spot: spotOf,
    beginLines: (_preset, language) => [
        ...duel.duelSetup(language === "es" ? ["Rojo", "Azul"] : ["Red", "Blue"]),
        ...tug.SETUP
    ],
    enterLines: (_run, one) => [duel.joinTeam(one.name, one.side)],
    goLines,
    tick,
    results: (run) => tug.scoresOf(run.entrants, run.points, tug.stateOf(run.game).wonBy),
    resultLines: (run, language) => [
        commands.say(tugMessages.result(tug.stateOf(run.game).wonBy, language))
    ],
    endLines: () => [...duel.duelTeardown(), ...tug.TEARDOWN]
};
