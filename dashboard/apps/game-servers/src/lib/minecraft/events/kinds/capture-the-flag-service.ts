/**
 * Playing capture the flag (`capture-the-flag.ts`): the arena's own steps are
 * `arena-service`'s; this is its part of them.
 *
 * Each tick reads what a duel's does - health, damage dealt, deaths and kills,
 * where everybody is - and what the quick look marked since (who touched a
 * flag, who stood at home), taken in one batch. In that order it then:
 * credits whoever the game says killed anybody who died, sends them back once
 * they are up again, puts any flag they carried back on its stand and wipes
 * what the quick look marked on them before the move; hands a flag at home
 * to whoever of the other team, alive, touched it; and counts a capture for a carrier who
 * reached their own base while their own flag stands there. The flags are
 * written into the run before a tick ends.
 */

import * as hits from "./hits";
import * as arena from "./arena";
import * as duel from "./team-duel";
import * as catalog from "../catalog";
import * as speech from "../../speech";
import * as written from "../messages";
import * as commands from "../commands";
import type * as stored from "../state";
import * as ctf from "./capture-the-flag";
import * as said from "./capture-the-flag-messages";
import type { ArenaGame, KindContext } from "./arena-game";

const messages = speech.spoken(written);
const flagMessages = speech.spoken(said);

const lower = (name: string) => name.toLowerCase();

function optionsOf(run: stored.EventRun): catalog.EventOptions<"capture-the-flag"> {
    return run.preset.options as catalog.EventOptions<"capture-the-flag">;
}

/** What one run keeps between ticks: nothing that must survive a restart. */
interface Memory {
    dealt: hits.Tally;
    kills: hits.Tally;
    lastHit: Map<string, number>;
    /** Who died and has not been seen back up yet, in lower case. */
    fallen: Set<string>;
}

const memories = new Map<string, Memory>();

function memoryOf(runId: string): Memory {
    let memory = memories.get(runId);
    if (!memory) {
        // Only a few runs are ever on at once, one a server.
        if (memories.size >= 16) memories.delete(memories.keys().next().value!);
        memory = {
            dealt: hits.tally(),
            kills: hits.tally(),
            lastHit: new Map(),
            fallen: new Set()
        };
        memories.set(runId, memory);
    }
    return memory;
}

/** Where an entrant starts: their side's row, in the order they came in. */
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
    return ctf.startSpot(run.arena!.box, entrant.side, slot);
}

async function goLines(ctx: KindContext, syntax: { marker: stored.Marker; itemCommand: boolean }) {
    const run = ctx.run;
    const options = optionsOf(run);
    const out: string[] = [];
    for (const one of run.entrants)
        out.push(
            arena.moveTo(one.name, spotOf(run, one)),
            ...duel
                .duelKit(options.kit)
                .map((id) =>
                    syntax.itemCommand && id === duel.OFFHAND_ITEM
                        ? arena.equipMarked(
                              one.name,
                              "weapon.offhand",
                              id,
                              syntax.marker,
                              arena.LASTS
                          )
                        : arena.giveMarked(one.name, id, 1, syntax.marker, arena.LASTS)
                ),
            ...arena.titleTo(
                one.name,
                messages.duelEnterTitle(one.side, ctx.language),
                flagMessages.enterSubtitle(options.captures, ctx.language)
            )
        );
    return out;
}

/** Who carried a quick look's mark when the tick took them (`TAKE_MARKS`). */
async function marked(ctx: KindContext, tag: string): Promise<Set<string>> {
    const names = commands
        .readWhere(await ctx.server.say([arena.readTagged(ctf.takenTag(tag))]))
        .map((one) => lower(one.name));
    return new Set(names);
}

async function tick(ctx: KindContext, lines: string[]): Promise<string | null> {
    const run = ctx.run;
    const language = ctx.language;
    const options = optionsOf(run);
    const box = run.arena!.box;
    const memory = memoryOf(run.id);
    const now = ctx.now;
    const marker = run.marker;
    const itemCommand = await ctx.atLeast([1, 17]);
    const say = (line: string) => ctx.server.say([line]);
    const hp = commands.readScores(await say(duel.READ_HP));
    const dealt = commands.readScores(await say(duel.READ_DEALT));
    const died = commands.readScores(await say(duel.READ_DIED));
    const killed = commands.readScores(await say(duel.READ_KILLS));
    const here = new Map(
        commands.readWhere(await say(commands.IN_OVERWORLD)).map((one) => [lower(one.name), one])
    );
    const health = duel.healthOf(
        hp,
        run.entrants.map((one) => one.name).filter((name) => here.has(lower(name)))
    );
    // Marked between ticks by the quick look, taken in one batch and read.
    await ctx.server.sayAll(ctf.TAKE_MARKS);
    const touched = [await marked(ctx, ctf.TOUCH_TAGS[0]), await marked(ctx, ctf.TOUCH_TAGS[1])];
    const atHome = [await marked(ctx, ctf.HOME_TAGS[0]), await marked(ctx, ctf.HOME_TAGS[1])];

    // Who struck and who killed since the last look; nothing on the first
    // after a restart, and a first score counted from 0.
    const on = new Set(here.keys());
    const killsSince = hits.rose(memory.kills, killed, on);
    for (const name of hits.rose(memory.dealt, dealt, on).keys()) memory.lastHit.set(name, now);

    const before = ctf.stateOf(run.game);
    const state: ctf.FlagState = {
        ...before,
        flags: [{ ...before.flags[0] }, { ...before.flags[1] }],
        kills: { ...before.kills }
    };
    const points = { ...run.points };
    const tally = { ...run.tally };
    const everybody = `@a[tag=${arena.IN_ARENA}]`;
    /** The flag `side` back on its stand, and its carrier no longer carrying it. */
    const flagHome = (side: number) => {
        const carrier = state.flags[side]!.carrier;
        state.flags[side] = { carrier: null };
        if (!carrier) return;
        if (marker) lines.push(arena.clearMarked(carrier, ctf.BANNERS[side]!, marker));
        lines.push(...ctf.droppedLines(carrier));
    };
    const carrying = (name: string) =>
        [0, 1].find((side) => lower(state.flags[side]!.carrier ?? "") === lower(name));
    const down = new Set<string>();

    for (const one of run.entrants) {
        const spot = spotOf(run, one);
        const hearts = health.get(one.name);
        const held = carrying(one.name);
        // Not on: whatever they carried goes home, and nothing else until they are back.
        if (hearts === undefined) {
            if (held !== undefined) {
                flagHome(held);
                lines.push(
                    commands.say(messages.tag(language) + flagMessages.returned(held, language))
                );
            }
            continue;
        }
        const rivals = run.entrants
            .filter((other) => other.side !== one.side)
            .map((other) => other.name);
        // Out by dying, as anywhere else in the game: what they carry is kept
        // through it (`keepInventory`, on for as long as the event lasts), and
        // a death is credited by the game's kill count - whoever comes back
        // from one is a new player, and the game forgets who hurt them.
        const dead = (died.get(one.name) ?? 0) > 0;
        if (dead) {
            const by = duel.creditFor(rivals, killsSince, memory.lastHit, now);
            if (by) state.kills[by] = (state.kills[by] ?? 0) + 1;
            lines.push(
                commands.say(messages.tag(language) + messages.duelDown(one.name, by, language))
            );
            lines.push(`scoreboard players set ${one.name} ${duel.DIED} 0`);
            if (held !== undefined) {
                flagHome(held);
                lines.push(
                    commands.say(
                        messages.tag(language) + flagMessages.dropped(one.name, held, language)
                    )
                );
            }
            down.add(lower(one.name));
            memory.fallen.add(lower(one.name));
        }
        const at = here.get(lower(one.name));
        // Back from a death - at their base already, where their spawn point
        // is (`respawn`) - or out of it any other way: back to their side,
        // healed and shielded for a moment - and whatever flag they carried
        // back on its stand.
        const fell = memory.fallen.has(lower(one.name));
        if (hearts > 0 && (fell || !at || !arena.contains(box, at))) {
            memory.fallen.delete(lower(one.name));
            lines.push(...duel.sendBack(one.name, spot), ...ctf.unmarkLines(one.name));
            const still = carrying(one.name);
            if (still !== undefined) {
                flagHome(still);
                lines.push(
                    commands.say(messages.tag(language) + flagMessages.returned(still, language))
                );
            }
            down.add(lower(one.name));
        }
    }

    // A flag at home taken by whoever of the other team touched it - in
    // passing, as the quick look saw, or standing at it now - alive: a
    // player dead by the flag is marked there until they come back.
    const alive = (name: string) => (health.get(name) ?? 0) > 0;
    for (const side of [0, 1]) {
        if (state.flags[side]!.carrier !== null) continue;
        const stand = ctf.standAt(box, side);
        const taker = run.entrants.find((one) => {
            const at = here.get(lower(one.name));
            return (
                one.side !== side &&
                at !== undefined &&
                alive(one.name) &&
                !down.has(lower(one.name)) &&
                carrying(one.name) === undefined &&
                (touched[side]!.has(lower(one.name)) || ctf.near(at, stand, ctf.TOUCH))
            );
        });
        if (!taker) continue;
        state.flags[side] = { carrier: taker.name };
        if (marker)
            lines.push(arena.wearMarked(taker.name, ctf.BANNERS[side]!, marker, itemCommand));
        lines.push(
            commands.say(messages.tag(language) + flagMessages.took(taker.name, side, language)),
            commands.sound(commands.SOUNDS.tick)
        );
    }

    // A carrier home with their own flag there: a capture.
    let decided: string | null = null;
    for (const side of [0, 1]) {
        const other = 1 - side;
        const carrier = state.flags[other]!.carrier;
        if (!carrier || state.flags[side]!.carrier !== null) continue;
        const one = run.entrants.find((each) => lower(each.name) === lower(carrier));
        const at = here.get(lower(carrier));
        if (!one || one.side !== side || !at || !alive(one.name) || down.has(lower(carrier)))
            continue;
        if (!atHome[side]!.has(lower(carrier)) && !ctf.near(at, ctf.standAt(box, side), ctf.HOME))
            continue;
        points[one.name] = (points[one.name] ?? 0) + 1;
        tally[String(side)] = (tally[String(side)] ?? 0) + 1;
        flagHome(other);
        lines.push(
            commands.setScore(one.name, points[one.name]!),
            commands.say(
                messages.tag(language) +
                    flagMessages.captured(
                        one.name,
                        other,
                        tally["0"] ?? 0,
                        tally["1"] ?? 0,
                        language
                    )
            ),
            ...arena.titleTo(everybody, flagMessages.capturedTitle(side, language), one.name),
            commands.sound(commands.SOUNDS.win)
        );
        if ((tally[String(side)] ?? 0) >= options.captures) decided = said.wonBy(side);
    }

    // The stands as the flags say, and each carrier seen by everybody.
    for (const side of [0, 1]) {
        const carrier = state.flags[side]!.carrier;
        lines.push(...ctf.standLines(box, side, carrier === null));
        if (carrier) lines.push(...ctf.carrierLines(carrier));
    }
    for (const one of run.entrants) {
        if (!health.has(one.name)) continue;
        const held = carrying(one.name);
        lines.push(
            arena.feed(one.name),
            arena.actionbarTo(
                one.name,
                held !== undefined
                    ? flagMessages.carryingBar(state.flags[one.side]!.carrier === null, language)
                    : flagMessages.statusBar(one.side, points[one.name] ?? 0, language)
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
    if (
        JSON.stringify(state) !== JSON.stringify(before) ||
        JSON.stringify(points) !== JSON.stringify(run.points) ||
        JSON.stringify(tally) !== JSON.stringify(run.tally)
    ) {
        ctx.run = { ...ctx.run, game: state, points, tally };
        await ctx.persist();
    }
    return decided;
}

export const captureTheFlag: ArenaGame = {
    most: () => ctf.MOST,
    reach: () => ctf.REACH,
    box: (_run, place) => ctf.arenaBox(place, place.y + arena.ALTITUDE),
    built: () => ({ design: ctf.DESIGN }),
    fills: (run, box) => ctf.arenaFills(box, ctf.coverFor(run.id)),
    blocks: () => [...ctf.ARENA_BLOCKS],
    kit: (run) => [...duel.duelKit(optionsOf(run).kit), ...ctf.BANNERS],
    teams: 2,
    side: (_run, index) => index % 2,
    spot: spotOf,
    // Back at their base, where they started.
    respawn: spotOf,
    beginLines: (_preset, language) =>
        duel.duelSetup(language === "es" ? ["Rojo", "Azul"] : ["Red", "Blue"]),
    enterLines: (_run, one) => [
        duel.joinTeam(one.name, one.side),
        ...ctf.TAGS.map((tag) => `tag ${one.name} remove ${tag}`),
        `tag ${one.name} add ${ctf.SIDE_TAGS[one.side]}`
    ],
    goLines,
    tick,
    quickLines: (run) => ctf.touchLines(run.arena!.box),
    results: (run) => new Map(run.entrants.map((one) => [one.name, run.points[one.name] ?? 0])),
    tiebreak: (run) =>
        ctf.tiebreakOf(
            ctf.stateOf(run.game),
            run.entrants.map((one) => one.name)
        ),
    resultLines: (run, language) => [
        commands.say(messages.duelResult(run.tally["0"] ?? 0, run.tally["1"] ?? 0, language))
    ],
    endLines: () => [...duel.duelTeardown(), ...ctf.TAGS_OFF]
};
