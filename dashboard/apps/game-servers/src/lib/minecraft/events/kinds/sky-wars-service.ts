/**
 * Playing SkyWars (`sky-wars.ts`): the arena's own steps are `arena-service`'s;
 * this is its part of them.
 *
 * Built, the islands' chests are filled (`decorate`), each item marked as the
 * kit. At "Go!" the cages come down. Each tick plays out the part Pillars
 * plays too (`last-standing-service.ts`): whoever died, fell under the
 * islands, left the play area or is gone put out, the last to hit them
 * credited. The last one left wins.
 */

import * as arena from "./arena";
import * as sw from "./sky-wars";
import * as catalog from "../catalog";
import * as speech from "../../speech";
import * as written from "../messages";
import * as commands from "../commands";
import type * as stored from "../state";
import * as said from "./sky-wars-messages";
import * as standing from "./last-standing-service";
import type { ArenaGame, ItemSyntax, KindContext } from "./arena-game";

const messages = speech.spoken(written);
const warMessages = speech.spoken(said);

const lower = (name: string) => name.toLowerCase();

function optionsOf(run: stored.EventRun): catalog.EventOptions<"sky-wars"> {
    return run.preset.options as catalog.EventOptions<"sky-wars">;
}

/** A run's islands, laid out once and kept: the search is not repeated every tick. */
const layouts = new Map<string, sw.Layout>();

function layoutOf(run: stored.EventRun): sw.Layout {
    const id = `${run.id}|${run.joined.length}`;
    let layout = layouts.get(id);
    if (!layout) {
        if (layouts.size >= 16) layouts.delete(layouts.keys().next().value!);
        layout = sw.layoutFor(run.id, run.joined.length);
        layouts.set(id, layout);
    }
    return layout;
}

/** Where the ring stands: over the place found, its height up. */
function atOf(run: stored.EventRun, place: stored.Point = run.place!): sw.Placed {
    return {
        x: place.x,
        y: sw.baseOver(layoutOf(run), place.y, optionsOf(run).height),
        z: place.z
    };
}

function spotOf(run: stored.EventRun, entrant: stored.Entrant): arena.Spot {
    return sw.startSpot(layoutOf(run), atOf(run), entrant.side);
}

async function goLines(ctx: KindContext): Promise<string[]> {
    const run = ctx.run;
    const out: string[] = [];
    for (const one of run.entrants)
        out.push(
            arena.moveTo(one.name, spotOf(run, one)),
            ...arena.titleTo(
                one.name,
                warMessages.goTitle(ctx.language),
                warMessages.goSubtitle(ctx.language)
            )
        );
    // Islands broken by hand: survival, but only with a marker to tell the
    // kit from what a broken block lets fall (`sw.quickLines`), so nothing
    // unmarked is carried home.
    if (run.marker) for (const one of run.entrants) out.push(`gamemode survival ${one.name}`);
    // The cages down last, everybody already on their own spot.
    out.push(...sw.cagesDown(layoutOf(run), atOf(run)));
    return out;
}

async function tick(ctx: KindContext, lines: string[]): Promise<string | null> {
    const run = ctx.run;
    const language = ctx.language;
    const layout = layoutOf(run);
    const at = atOf(run);
    const before = sw.stateOf(run.game);
    const state: sw.WarState = structuredClone(before);
    const { left } = await standing.play(ctx, lines, state, {
        play: sw.playArea(layout, at),
        gallery: sw.galleryFloor(layout, at),
        seat: (index) => sw.gallerySpot(layout, at, index),
        outTag: sw.OUT_TAG,
        goneTag: sw.GONE_TAG,
        kit: sw.LOOT_IDS,
        said: warMessages,
        tag: messages.tag(language)
    });

    // The winner is named with the results (`resultLines`), once the anti-cheat
    // has been asked: named here, a player kept off the podium was cheered.
    const decided = left.length <= 1 ? said.LAST_ONE : null;
    lines.push(
        `bossbar set ${commands.BAR} name ${commands.text(
            warMessages.bar(left.length, messages.clock((run.endsAt - ctx.now) / 1000), language)
        )}`,
        ...arena.keepThrown(run.arena!.box)
    );
    await standing.keep(ctx, state, before);
    return decided;
}

export const skyWars: ArenaGame = {
    most: () => sw.MOST,
    reach: (run) => sw.reachOf(layoutOf(run)),
    box: (run, place) => sw.arenaBox(layoutOf(run), atOf(run, place)),
    built: () => ({ design: sw.DESIGN }),
    fills: (run) => sw.arenaFills(layoutOf(run), atOf(run)),
    decorSpots: (run) => sw.decorSpots(layoutOf(run), atOf(run)),
    blocks: () => [...sw.ARENA_BLOCKS],
    trim: sw.TRIM,
    decorate: (run, _box, syntax: ItemSyntax) =>
        sw.chestLines(
            run.id,
            layoutOf(run),
            atOf(run),
            optionsOf(run).loot,
            syntax.marker,
            syntax.itemCommand
        ),
    kit: () => [...sw.LOOT_IDS],
    side: (_run, index) => index,
    spot: spotOf,
    // Out, up in the gallery: where the tick sends whoever died anyway, and
    // where they respawn if the server can say so (`in-server.respawnSet`).
    respawn: (run) => sw.gallerySpot(layoutOf(run), atOf(run), 0),
    beginLines: () => sw.setupLines(),
    enterLines: (_run, one) => [
        `tag ${one.name} remove ${sw.OUT_TAG}`,
        `tag ${one.name} remove ${sw.GONE_TAG}`
    ],
    goLines,
    tick,
    quickLines: (run) => sw.quickLines(layoutOf(run), atOf(run), run.arena!.box, run.marker),
    results: (run) =>
        sw.scoresOf(
            sw.stateOf(run.game),
            run.entrants.map((one) => one.name)
        ),
    tiebreak: (run) =>
        sw.tiebreakOf(
            sw.stateOf(run.game),
            run.entrants.map((one) => one.name)
        ),
    resultLines: (run, language, disqualified) => {
        const state = sw.stateOf(run.game);
        const left = run.entrants.filter(
            (one) => !state.out.some((out) => lower(out.name) === lower(one.name))
        );
        return left.length === 1 && !disqualified.has(lower(left[0]!.name))
            ? [commands.say(warMessages.winner(left[0]!.name, language))]
            : [];
    },
    endLines: () => [...sw.TEARDOWN],
    closeLines: (box) =>
        ["arrow", "snowball", "ender_pearl"].map(
            (type) =>
                `execute in minecraft:overworld run kill @e[type=minecraft:${type},${arena.within(box)}]`
        )
};
