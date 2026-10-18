/**
 * Playing Pillars (`pillars.ts`): the arena's own steps are `arena-service`'s;
 * this is its part of them, played the way SkyWars' is (`sky-wars-service.ts`).
 *
 * At "Go!" everybody is on their pillar in survival and the events pack's
 * drops are switched on: from then on the server hands out the items itself.
 * Where the pack could not be put on, each tick gives the latest drop due,
 * every player's in one batch. Each tick plays out the part SkyWars plays too
 * (`last-standing-service.ts`), with whoever the void caught put out for it,
 * and stirs in a twist when one is due. The last one left wins.
 *
 * What the players are shown is the same as everywhere else in the events: a
 * title and the start's bell at "Go!", the boss bar with who is left and when
 * the void rises (`barName`), the void drawn where it stands once it rises, a thud everybody hears when somebody is out, and the winner's title
 * and burst of sparks with the results (`stage.finishBurst`).
 */

import * as pi from "./pillars";
import * as arena from "./arena";
import * as sw from "./sky-wars";
import * as catalog from "../catalog";
import * as speech from "../../speech";
import * as written from "../messages";
import * as commands from "../commands";
import type * as stored from "../state";
import * as said from "./pillars-messages";
import * as stage from "./stage";
import * as hitsService from "./hits-service";
import * as standing from "./last-standing-service";
import type { ArenaGame, KindContext } from "./arena-game";

const messages = speech.spoken(written);
const pillarMessages = speech.spoken(said);

const lower = (name: string) => name.toLowerCase();

/** Everybody in the game, standing or out, at their own position. */
const IN_GAME = `@a[tag=${pi.IN_TAG}]`;

/** The thud everybody in the game hears when somebody is out. */
const OUT_SOUND = `execute as ${IN_GAME} at @s run playsound minecraft:block.anvil.land master @s ~ ~ ~ 0.4 1.6`;

function optionsOf(run: stored.EventRun): catalog.EventOptions<"pillars"> {
    return run.preset.options as catalog.EventOptions<"pillars">;
}

function designOf(run: stored.EventRun): number {
    return pi.stateOf(run.game).design;
}

function layoutOf(run: stored.EventRun): pi.Layout {
    return pi.layoutFor(run.joined.length, optionsOf(run).middle, designOf(run));
}

function atOf(run: stored.EventRun, place: stored.Point = run.place!): pi.Placed {
    return { x: place.x, y: pi.topOver(place.y, optionsOf(run).height, designOf(run)), z: place.z };
}

function spotOf(run: stored.EventRun, entrant: stored.Entrant): arena.Spot {
    return pi.startSpot(layoutOf(run), atOf(run), entrant.side);
}

/** Where the void stands now. */
function floorOf(run: stored.EventRun, now: number): number {
    return pi.voidLevel(
        pi.playArea(layoutOf(run), atOf(run)),
        run.readyAt,
        optionsOf(run).voidAfter,
        now
    );
}

async function goLines(ctx: KindContext): Promise<string[]> {
    const run = ctx.run;
    const options = optionsOf(run);
    const out: string[] = [];
    for (const one of run.entrants)
        out.push(
            arena.moveTo(one.name, spotOf(run, one)),
            `tag ${one.name} add ${pi.IN_TAG}`,
            ...arena.titleTo(
                one.name,
                pillarMessages.goTitle(ctx.language),
                pillarMessages.goSubtitle(ctx.language)
            )
        );
    out.push(
        `execute as ${IN_GAME} at @s run playsound ${commands.SOUNDS.start} master @s ~ ~ ~ 1 1 0`
    );
    // Survival only with a marker to tell the kit from anything else
    // (`arena.killBrokenDrops`), so nothing unmarked is carried home.
    if (run.marker) {
        for (const one of run.entrants) out.push(`gamemode survival ${one.name}`);
        // The drops handed out inside the server, where the pack is on.
        if (await hitsService.ensure(ctx))
            out.push(...pi.armLines(options.interval, options.pool, run.marker));
    }
    return out;
}

async function tick(ctx: KindContext, lines: string[]): Promise<string | null> {
    const run = ctx.run;
    const language = ctx.language;
    const options = optionsOf(run);
    const layout = layoutOf(run);
    const at = atOf(run);
    const play = pi.playArea(layout, at);
    const now = ctx.now;
    const marker = run.marker;
    const floor = floorOf(run, now);
    const risen = floor > play.y1;
    const swallowed = risen
        ? new Set(
              commands
                  .readWhere(await ctx.server.say([arena.readTagged(pi.VOID_TAG)]))
                  .map((one) => lower(one.name))
          )
        : new Set<string>();

    const before = pi.stateOf(run.game);
    const state: pi.PillarState = structuredClone(before);
    const { here, left } = await standing.play(ctx, lines, state, {
        play,
        gallery: pi.galleryFloor(layout, at),
        seat: (index) => pi.gallerySpot(layout, at, index),
        outTag: pi.OUT_TAG,
        goneTag: pi.GONE_TAG,
        kit: pi.KIT_IDS,
        why: (name, where) =>
            risen && (where.y < floor || swallowed.has(lower(name))) ? "void" : null,
        outLines: (name) => [
            `tag ${name} remove ${pi.VOID_TAG}`,
            `effect clear ${name}`,
            OUT_SOUND
        ],
        said: pillarMessages,
        tag: messages.tag(language)
    });

    const decided = left.length <= 1 ? said.LAST_ONE : null;
    const readyAt = run.readyAt ?? now;

    if (!decided && marker) {
        // The pack's drops; or, where it is not on, the loop's, all in one
        // batch: only the latest due, nothing made up for after a pause.
        const pack = await hitsService.ensure(ctx);
        if (!pack) {
            const due = pi.dropsDue(readyAt, options.interval, now);
            if (state.drops < due) {
                const standingNow = left
                    .filter((one) => here.has(lower(one.name)))
                    .map((one) => one.name);
                lines.push(
                    ...pi.dropLines(run.id, due - 1, standingNow, options.pool, marker),
                    ...pi.DROP_FEEDBACK
                );
                state.drops = due;
            }
        }
        const twists = pi.twistsDue(readyAt, now);
        if (options.twists && state.twists < twists) {
            state.twists = twists;
            const twist = pi.twistOf(run.id, twists - 1);
            lines.push(
                ...pi.twistLines(twist),
                commands.say(messages.tag(language) + pillarMessages.twistLine(twist, language))
            );
            if (twist === "bonus")
                lines.push(
                    ...(pack
                        ? [pi.DROP_NOW]
                        : pi.dropLines(
                              `${run.id}-bonus`,
                              twists,
                              left.map((one) => one.name),
                              options.pool,
                              marker
                          ))
                );
        }
        if (risen && !state.rising) {
            state.rising = true;
            lines.push(
                commands.say(messages.tag(language) + pillarMessages.voidRising(language)),
                `execute as ${IN_GAME} at @s run playsound minecraft:entity.wither.ambient master @s ~ ~ ~ 0.6 0.6`
            );
        }
    }
    lines.push(...pi.voidLines(play, floor), ...arena.keepThrown(run.arena!.box));
    await standing.keep(ctx, state, before);
    return decided;
}

export const pillars: ArenaGame = {
    most: () => pi.MOST,
    reach: (run) => pi.reachOf(layoutOf(run)),
    box: (run, place) => pi.arenaBox(layoutOf(run), atOf(run, place)),
    built: () => ({ design: pi.DESIGN }),
    fills: (run) => pi.arenaFills(layoutOf(run), atOf(run)),
    decorSpots: (run) => pi.decorSpots(layoutOf(run), atOf(run)),
    blocks: () => [...pi.ARENA_BLOCKS],
    trim: pi.TRIM,
    kit: () => [...pi.KIT_IDS],
    // The events pack hands out the drops; put on before anything is built.
    hits: true,
    side: (_run, index) => index,
    spot: spotOf,
    respawn: (run) => pi.gallerySpot(layoutOf(run), atOf(run), 0),
    beginLines: () => sw.setupLines(),
    enterLines: (_run, one) => [
        `tag ${one.name} remove ${pi.OUT_TAG}`,
        `tag ${one.name} remove ${pi.GONE_TAG}`,
        `tag ${one.name} remove ${pi.VOID_TAG}`
    ],
    goLines,
    tick,
    barName: (run, now, language) => {
        const state = pi.stateOf(run.game);
        const left = run.entrants.filter(
            (one) => !state.out.some((out) => lower(out.name) === lower(one.name))
        ).length;
        const { voidAfter } = optionsOf(run);
        const voidIn = pi.voidRisesIn(run.readyAt, voidAfter, now);
        return pillarMessages.bar(
            left,
            messages.clock((run.endsAt - now) / 1000),
            voidIn === null ? null : messages.clock(voidIn),
            voidIn === null && voidAfter > 0 && run.readyAt !== null,
            language
        );
    },
    quickLines: (run) => {
        const at = atOf(run);
        const layout = layoutOf(run);
        return [
            ...pi.quickLines(
                layout,
                at,
                run.arena!.box,
                floorOf(run, Date.now()),
                run.entrants.map((one) => one.name)
            ),
            ...(run.marker ? [arena.killBrokenDrops(run.arena!.box, run.marker)] : [])
        ];
    },
    results: (run) =>
        sw.scoresOf(
            pi.stateOf(run.game),
            run.entrants.map((one) => one.name)
        ),
    tiebreak: (run) =>
        sw.tiebreakOf(
            pi.stateOf(run.game),
            run.entrants.map((one) => one.name)
        ),
    resultLines: (run, language, disqualified) => {
        const state = pi.stateOf(run.game);
        const left = run.entrants.filter(
            (one) => !state.out.some((out) => lower(out.name) === lower(one.name))
        );
        if (left.length !== 1 || disqualified.has(lower(left[0]!.name))) return [];
        const name = left[0]!.name;
        return [
            commands.say(pillarMessages.winner(name, language)),
            ...run.entrants.flatMap((one) =>
                arena.titleTo(
                    one.name,
                    pillarMessages.winnerTitle(name, language),
                    pillarMessages.winnerSubtitle(language)
                )
            ),
            ...stage.finishBurst(name)
        ];
    },
    endLines: () => [...pi.STOP_LINES, ...sw.TEARDOWN],
    closeLines: (box) => [
        ...pi.STOP_LINES,
        ...["arrow", "snowball", "ender_pearl", "tnt"].map(
            (type) =>
                `execute in minecraft:overworld run kill @e[type=minecraft:${type},${arena.within(box)}]`
        )
    ]
};
