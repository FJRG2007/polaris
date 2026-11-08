/**
 * Playing a knockback brawl (`knockback-brawl.ts`): the arena's own steps are
 * `arena-service`'s; this is its part of them, played the way Pillars' is
 * (`pillars-service.ts`).
 *
 * At "Go!" everybody is on the platform and handed the stick, one line for
 * them all. Each tick plays out the part SkyWars and Pillars play too
 * (`last-standing-service.ts`), keeps everybody standing unhurt, and hands a
 * stick back to whoever threw theirs away - every one of these a single line
 * whatever the number of players. The last one left wins; at the time, the
 * most knock-offs among those still standing.
 */

import * as arena from "./arena";
import * as sw from "./sky-wars";
import * as stage from "./stage";
import * as catalog from "../catalog";
import * as speech from "../../speech";
import * as written from "../messages";
import * as kb from "./knockback-brawl";
import * as commands from "../commands";
import type * as stored from "../state";
import * as said from "./knockback-brawl-messages";
import * as standing from "./last-standing-service";
import type { ArenaGame, KindContext } from "./arena-game";

const messages = speech.spoken(written);
const brawlMessages = speech.spoken(said);

const lower = (name: string) => name.toLowerCase();

/** Everybody in the game, standing or out, at their own position. */
const IN_GAME = `@a[tag=${kb.IN_TAG}]`;
/** The thud everybody in the game hears when somebody is out. */
const OUT_SOUND = `execute as ${IN_GAME} at @s run playsound minecraft:block.anvil.land master @s ~ ~ ~ 0.4 1.6`;

function optionsOf(run: stored.EventRun): catalog.EventOptions<"knockback-brawl"> {
    return run.preset.options as catalog.EventOptions<"knockback-brawl">;
}

function layoutOf(run: stored.EventRun): kb.Layout {
    return kb.layoutFor(run.joined.length);
}

function atOf(run: stored.EventRun, place: stored.Point = run.place!): kb.Placed {
    return { x: place.x, y: kb.topOver(place.y), z: place.z };
}

function spotOf(run: stored.EventRun, entrant: stored.Entrant): arena.Spot {
    return kb.startSpot(layoutOf(run), atOf(run), entrant.side);
}

/** Whoever entered and can be put into a command. */
function namesOf(run: stored.EventRun): string[] {
    return run.entrants.map((one) => one.name).filter((name) => catalog.PLAYER_NAME.test(name));
}

/** The stick for everybody standing who has none, in every reader's language. */
function stickLines(run: stored.EventRun, language: speech.Speech): string[] {
    if (!run.marker) return [];
    return kb.stickLines(
        run.marker,
        kb.stateOf(run.game).spelling,
        brawlMessages.stickName(language),
        optionsOf(run).knockback
    );
}

async function prepare(ctx: KindContext): Promise<Record<string, unknown>> {
    const spelling: kb.NameSpelling = (await ctx.atLeast([1, 21, 5]))
        ? "text"
        : (await ctx.atLeast([1, 20, 5]))
          ? "json"
          : "tag";
    return { spelling };
}

async function goLines(ctx: KindContext): Promise<string[]> {
    const run = ctx.run;
    const out: string[] = [];
    for (const one of run.entrants) {
        if (!catalog.PLAYER_NAME.test(one.name)) continue;
        out.push(
            arena.moveTo(one.name, spotOf(run, one)),
            `tag ${one.name} add ${kb.IN_TAG}`,
            ...arena.titleTo(
                one.name,
                brawlMessages.goTitle(ctx.language),
                brawlMessages.goSubtitle(ctx.language)
            )
        );
    }
    out.push(
        ...kb.PLAY_EFFECTS,
        ...stickLines(run, ctx.language),
        `execute as ${IN_GAME} at @s run playsound ${commands.SOUNDS.start} master @s ~ ~ ~ 1 1 0`
    );
    return out;
}

async function tick(ctx: KindContext, lines: string[]): Promise<string | null> {
    const run = ctx.run;
    const layout = layoutOf(run);
    const at = atOf(run);
    const before = kb.stateOf(run.game);
    const state: kb.BrawlState = structuredClone(before);
    const { left } = await standing.play(ctx, lines, state, {
        play: kb.playArea(layout, at),
        gallery: kb.galleryFloor(layout, at),
        seat: (index) => kb.gallerySpot(layout, at, index),
        outTag: kb.OUT_TAG,
        goneTag: kb.GONE_TAG,
        kit: kb.KIT_IDS,
        outLines: (name) => [`effect clear ${name}`, OUT_SOUND],
        said: brawlMessages,
        tag: messages.tag(ctx.language)
    });
    const decided = left.length <= 1 ? said.LAST_ONE : null;
    if (!decided) lines.push(...kb.PLAY_EFFECTS, ...stickLines(run, ctx.language));
    lines.push(...arena.keepThrown(run.arena!.box));
    await standing.keep(ctx, state, before);
    return decided;
}

export const knockbackBrawl: ArenaGame = {
    most: () => kb.MOST,
    reach: (run) => kb.reachOf(layoutOf(run)),
    box: (run, place) => kb.arenaBox(layoutOf(run), atOf(run, place)),
    prepare,
    built: (run) => ({ design: kb.DESIGN, spelling: kb.stateOf(run.game).spelling }),
    fills: (run) => kb.arenaFills(layoutOf(run), atOf(run)),
    decorSpots: (run) => kb.decorSpots(layoutOf(run), atOf(run)),
    blocks: () => [...kb.ARENA_BLOCKS],
    kit: () => [...kb.KIT_IDS],
    side: (_run, index) => index,
    spot: spotOf,
    respawn: (run) => kb.gallerySpot(layoutOf(run), atOf(run), 0),
    beginLines: () => sw.setupLines(),
    enterLines: (_run, one) => [
        `tag ${one.name} remove ${kb.OUT_TAG}`,
        `tag ${one.name} remove ${kb.GONE_TAG}`
    ],
    goLines,
    tick,
    barName: (run, now, language) =>
        brawlMessages.bar(
            kb.standing(kb.stateOf(run.game), namesOf(run)).length,
            messages.clock((run.endsAt - now) / 1000),
            language
        ),
    quickLines: (run) => [
        ...kb.quickLines(layoutOf(run), atOf(run), run.arena!.box, namesOf(run)),
        ...(run.marker ? [arena.killBrokenDrops(run.arena!.box, run.marker)] : [])
    ],
    results: (run) => sw.scoresOf(kb.stateOf(run.game), namesOf(run)),
    tiebreak: (run) => sw.tiebreakOf(kb.stateOf(run.game), namesOf(run)),
    resultLines: (run, language, disqualified) => {
        const state = kb.stateOf(run.game);
        const names = namesOf(run);
        const name = kb.winnerOf(state, names);
        if (!name || disqualified.has(lower(name))) return [];
        const lastOne = kb.standing(state, names).length === 1;
        return [
            commands.say(
                lastOne
                    ? brawlMessages.winner(name, language)
                    : brawlMessages.winnerOnTime(name, state.kills[name] ?? 0, language)
            ),
            ...names.flatMap((one) =>
                arena.titleTo(
                    one,
                    brawlMessages.winnerTitle(name, language),
                    brawlMessages.winnerSubtitle(language)
                )
            ),
            ...stage.finishBurst(name)
        ];
    },
    endLines: () => [...kb.STOP_LINES, ...sw.TEARDOWN],
    closeLines: () => [...kb.STOP_LINES]
};
