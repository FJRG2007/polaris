/**
 * Playing the glass bridge (`glass-bridge.ts`): the arena's own steps are
 * `arena-service`'s; this is its part of them.
 *
 * Each tick - twice a second - reads where everybody is and, in this order:
 * puts out whoever has been gone from the server for `MISSING_MS`; for each
 * walker, puts them out once they are under the glass, counts them across
 * once they stand on the finish, and otherwise notes the furthest row they
 * have reached and breaks a panel they stand on that the pack missed; in
 * turns, puts out a walker who has not reached a new row in `turnSeconds`, and
 * hands the bridge to the next in the order once the walker is done. Then it
 * keeps everybody where they belong: whoever is out in the gallery, whoever
 * crossed on the finish, whoever is waiting their turn on the start. The
 * run's game is written before a tick ends, its times as clock times, so a
 * restart picks it up where it was.
 */

import * as arena from "./arena";
import * as catalog from "../catalog";
import * as speech from "../../speech";
import * as written from "../messages";
import * as glass from "./glass-bridge";
import * as commands from "../commands";
import type * as stored from "../state";
import * as said from "./glass-bridge-messages";
import type { ArenaGame, KindContext } from "./arena-game";

const messages = speech.spoken(written);
const bridgeMessages = speech.spoken(said);

const lower = (name: string) => name.toLowerCase();

function optionsOf(run: stored.EventRun): catalog.EventOptions<"glass-bridge"> {
    return run.preset.options as catalog.EventOptions<"glass-bridge">;
}

function layoutOf(run: stored.EventRun): glass.Layout {
    return glass.layoutOf(run.arena!.box, optionsOf(run).steps);
}

/** What one run keeps between ticks: nothing that must survive a restart. */
interface Memory {
    /** When each player was first seen gone from the server, this time. */
    missing: Map<string, number>;
}

const memories = new Map<string, Memory>();

function memoryOf(runId: string): Memory {
    let memory = memories.get(runId);
    if (!memory) {
        if (memories.size >= 16) memories.delete(memories.keys().next().value!);
        memory = { missing: new Map() };
        memories.set(runId, memory);
    }
    return memory;
}

/** How long a player may be off the server before they are out. */
const MISSING_MS = 4_000;

/** The game as "Go!" left it: in turns, the order drawn and the first on. */
function firstState(run: stored.EventRun, now: number): glass.BridgeState {
    const start = run.readyAt ?? now;
    const turns = optionsOf(run).mode === "turns";
    return glass.stateSchema.parse({
        order: turns
            ? glass.orderFor(
                  run.id,
                  run.entrants.map((one) => one.name)
              )
            : [],
        turn: turns ? 0 : null,
        movedAt: start,
        turnAt: start
    });
}

function spotOf(run: stored.EventRun, entrant: stored.Entrant): arena.Spot {
    return glass.startSpot(layoutOf(run), entrant.side);
}

async function goLines(ctx: KindContext): Promise<string[]> {
    const run = ctx.run;
    const options = optionsOf(run);
    const layout = layoutOf(run);
    const state = firstState(run, ctx.now);
    const names = run.entrants.map((one) => one.name);
    const walking = new Set(glass.walkers(state, options.mode, names).map(lower));
    const out: string[] = [
        ...glass.armLines(run.arena!.box, layout, run.id),
        ...glass.noPushLines(names)
    ];
    for (const one of run.entrants)
        out.push(
            arena.moveTo(one.name, spotOf(run, one)),
            glass.walkerLine(one.name, walking.has(lower(one.name))),
            ...arena.titleTo(
                one.name,
                bridgeMessages.goTitle(ctx.language),
                walking.has(lower(one.name)) || options.mode === "free"
                    ? bridgeMessages.goSubtitle(ctx.language)
                    : bridgeMessages.waitSubtitle(ctx.language)
            )
        );
    if (options.mode === "turns") {
        out.push(
            commands.say(
                messages.tag(ctx.language) + bridgeMessages.orderLine(state.order, ctx.language)
            )
        );
        const first = state.order[0];
        if (first)
            out.push(
                ...arena.titleTo(
                    first,
                    bridgeMessages.turnTitle(ctx.language),
                    bridgeMessages.turnSubtitle(options.turnSeconds, ctx.language)
                )
            );
    }
    return out;
}

async function tick(ctx: KindContext, lines: string[]): Promise<string | null> {
    const run = ctx.run;
    const language = ctx.language;
    const options = optionsOf(run);
    const layout = layoutOf(run);
    const now = ctx.now;
    const memory = memoryOf(run.id);
    const here = new Map(
        commands
            .readWhere(await ctx.server.say([commands.IN_OVERWORLD]))
            .map((one) => [lower(one.name), one])
    );
    const names = run.entrants.map((one) => one.name);
    const before = glass.stateOf(run.game);
    const state = structuredClone(before ?? firstState(run, now));
    const reachedOf = (name: string) => {
        const key = Object.keys(state.reached).find((one) => lower(one) === lower(name));
        return key ? state.reached[key]!.rows : 0;
    };
    const putOut = (name: string) =>
        state.out.push({ name, at: now, rows: reachedOf(name), seconds: 0 });

    // Gone from the server for a while: out.
    for (const name of names) {
        if (glass.isDone(state, name)) continue;
        if (here.has(lower(name))) {
            memory.missing.delete(lower(name));
            continue;
        }
        const since = memory.missing.get(lower(name)) ?? now;
        memory.missing.set(lower(name), since);
        if (now - since < MISSING_MS) continue;
        putOut(name);
        lines.push(commands.say(messages.tag(language) + bridgeMessages.leftGame(name, language)));
    }

    // Each walker: under the glass, across, or a row further.
    for (const name of glass.walkers(state, options.mode, names)) {
        const at = here.get(lower(name));
        if (!at) continue;
        if (glass.fallen(layout, at)) {
            lines.push(
                commands.say(
                    messages.tag(language) + bridgeMessages.fell(name, reachedOf(name), language)
                ),
                ...arena.titleTo(
                    name,
                    bridgeMessages.outTitle(language),
                    bridgeMessages.outSubtitle(language)
                )
            );
            putOut(name);
            continue;
        }
        if (glass.onFinish(layout, at)) {
            const seconds = Math.max(0, (now - (run.readyAt ?? now)) / 1000);
            const key =
                Object.keys(state.reached).find((one) => lower(one) === lower(name)) ?? name;
            state.reached[key] = { rows: layout.steps, at: now };
            state.finished.push({ name, at: now, rows: layout.steps, seconds });
            lines.push(
                commands.say(
                    messages.tag(language) +
                        bridgeMessages.crossed(name, state.finished.length, seconds, language)
                ),
                ...arena.titleTo(name, bridgeMessages.crossedTitle(language), ""),
                commands.sound(commands.SOUNDS.win)
            );
            continue;
        }
        const rows = glass.rowsReached(layout, at);
        if (rows !== null && rows > reachedOf(name)) {
            const key =
                Object.keys(state.reached).find((one) => lower(one) === lower(name)) ?? name;
            state.reached[key] = { rows, at: now };
            state.movedAt = now;
        }
        // The pack breaks a panel the tick it is stood on; one it missed goes now.
        const panel = glass.breakingUnder(layout, run.id, at);
        if (panel) lines.push(...glass.shatterLines(panel));
    }

    if (options.mode === "turns") {
        // Standing still too long on the bridge: out.
        const walker = glass.walkers(state, "turns", names)[0];
        if (walker && now - (state.movedAt ?? now) > options.turnSeconds * 1000) {
            putOut(walker);
            lines.push(
                commands.say(messages.tag(language) + bridgeMessages.tooSlow(walker, language)),
                ...arena.titleTo(
                    walker,
                    bridgeMessages.outTitle(language),
                    bridgeMessages.outSubtitle(language)
                )
            );
        }
        // The walker done: the next in the order who is not.
        if (glass.walkers(state, "turns", names).length === 0 && state.turn !== null) {
            const next = state.order.findIndex(
                (name, index) => index > state.turn! && !glass.isDone(state, name)
            );
            state.turn = next === -1 ? null : next;
            state.movedAt = now;
            state.turnAt = now;
            const name = next === -1 ? null : state.order[next]!;
            if (name)
                lines.push(
                    commands.say(messages.tag(language) + bridgeMessages.turnLine(name, language)),
                    ...arena.titleTo(
                        name,
                        bridgeMessages.turnTitle(language),
                        bridgeMessages.turnSubtitle(options.turnSeconds, language)
                    ),
                    commands.sound(commands.SOUNDS.start)
                );
        }
    }

    // Everybody where they belong, unhurt, and only walkers able to break glass.
    const walking = new Set(glass.walkers(state, options.mode, names).map(lower));
    const current =
        options.mode === "turns" && state.turn !== null ? (state.order[state.turn] ?? null) : null;
    const finishedNames = state.finished.map((one) => lower(one.name));
    for (const [index, one] of run.entrants.entries()) {
        const at = here.get(lower(one.name));
        if (!at) continue;
        lines.push(
            ...glass.unhurtLines(one.name),
            glass.walkerLine(one.name, walking.has(lower(one.name)))
        );
        const finishedAt = finishedNames.indexOf(lower(one.name));
        if (finishedAt !== -1) {
            if (!glass.onFinish(layout, at))
                lines.push(arena.moveTo(one.name, glass.finishSpot(layout, finishedAt)));
            lines.push(arena.actionbarTo(one.name, bridgeMessages.finishedBar(language)));
        } else if (glass.isDone(state, one.name)) {
            if (!glass.inGallery(layout, at))
                lines.push(arena.moveTo(one.name, glass.gallerySpot(layout, index)));
            lines.push(arena.actionbarTo(one.name, bridgeMessages.galleryBar(language)));
        } else if (!walking.has(lower(one.name))) {
            if (!glass.onStart(layout, at)) lines.push(arena.moveTo(one.name, spotOf(run, one)));
            lines.push(arena.actionbarTo(one.name, bridgeMessages.waitingBar(current, language)));
        } else {
            const left =
                options.mode === "turns"
                    ? options.turnSeconds - (now - (state.movedAt ?? now)) / 1000
                    : null;
            lines.push(
                arena.actionbarTo(
                    one.name,
                    bridgeMessages.walkingBar(reachedOf(one.name), layout.steps, left, language)
                )
            );
        }
    }
    const done = names.filter((name) => glass.isDone(state, name)).length;
    lines.push(
        `bossbar set ${commands.BAR} name ${commands.text(
            bridgeMessages.bar(names.length - done, state.finished.length, language)
        )}`
    );

    if (JSON.stringify(state) !== JSON.stringify(before)) {
        ctx.run = {
            ...ctx.run,
            game: state,
            points: Object.fromEntries(glass.scoresOf(state, names, catalog.FINISH_BASE))
        };
        await ctx.persist();
    }
    // The winner is named with the results (`resultLines`), once the anti-cheat
    // has been asked.
    return done >= names.length ? said.ALL_DONE : null;
}

export const glassBridge: ArenaGame = {
    most: () => glass.MOST,
    reach: (run) => glass.reachOf(optionsOf(run).steps),
    box: (run, place) => glass.bridgeBox(place, place.y + arena.ALTITUDE, optionsOf(run).steps),
    fills: (run, box) => glass.bridgeFills(box, optionsOf(run).steps),
    decorSpots: (run, box) => glass.decorSpots(box, optionsOf(run).steps),
    blocks: () => [...glass.BRIDGE_BLOCKS],
    trim: glass.TRIM,
    kit: () => [],
    // The events data pack breaks the glass (`glass-bridge.FUNCTIONS`): put on
    // before anything is built.
    hits: true,
    side: (_run, index) => index,
    spot: spotOf,
    goLines,
    tick,
    results: (run) =>
        glass.scoresOf(
            glass.stateOf(run.game),
            run.entrants.map((one) => one.name),
            catalog.FINISH_BASE
        ),
    tiebreak: (run) => glass.tiebreakOf(glass.stateOf(run.game)),
    resultLines: (run, language, disqualified) => {
        const state = glass.stateOf(run.game);
        const winner = glass.winnerOf(
            state,
            run.entrants.map((one) => one.name),
            catalog.FINISH_BASE,
            disqualified
        );
        if (!winner) return [];
        const across = state?.finished.some((one) => lower(one.name) === lower(winner)) ?? false;
        return [commands.say(bridgeMessages.winner(winner, across, language))];
    },
    endLines: (run) => (run.arena ? glass.stopLines(run.arena.box) : []),
    closeLines: (box) => glass.stopLines(box)
};
