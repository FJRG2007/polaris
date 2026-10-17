/**
 * Playing Pillars (`pillars.ts`): the arena's own steps are `arena-service`'s;
 * this is its part of them, played the way SkyWars' is (`sky-wars-service.ts`).
 *
 * At "Go!" everybody is on their pillar in survival and the events pack's
 * drops are switched on: from then on the server hands out the items itself.
 * Where the pack could not be put on, each tick gives whatever drops fell due
 * since the last one, every player's in one batch. Each tick reads deaths,
 * hits and where everybody is, puts out whoever died, fell, left the play area,
 * went under the void or has been off the server two looks running - their
 * kit taken, up to the gallery, the last to hit them credited - and stirs in a
 * twist when one is due. The last one left wins.
 */

import * as hits from "./hits";
import * as pi from "./pillars";
import * as arena from "./arena";
import * as sw from "./sky-wars";
import * as duel from "./team-duel";
import * as catalog from "../catalog";
import * as speech from "../../speech";
import * as written from "../messages";
import * as commands from "../commands";
import type * as stored from "../state";
import * as said from "./pillars-messages";
import * as hitsService from "./hits-service";
import type { ArenaGame, KindContext } from "./arena-game";

const messages = speech.spoken(written);
const pillarMessages = speech.spoken(said);

const lower = (name: string) => name.toLowerCase();

function optionsOf(run: stored.EventRun): catalog.EventOptions<"pillars"> {
    return run.preset.options as catalog.EventOptions<"pillars">;
}

function layoutOf(run: stored.EventRun): pi.Layout {
    return pi.layoutFor(run.joined.length, optionsOf(run).middle);
}

function atOf(run: stored.EventRun, place: stored.Point = run.place!): pi.Placed {
    return { x: place.x, y: pi.topOver(place.y, optionsOf(run).height), z: place.z };
}

/** What one run keeps between ticks: nothing that must survive a restart. */
interface Memory {
    dealt: hits.Tally;
    taken: hits.Tally;
    bows: hits.Tally;
    kills: hits.Tally;
    hitBy: Map<string, { by: string; at: number }>;
    missing: Map<string, number>;
}

const memories = new Map<string, Memory>();

function memoryOf(runId: string): Memory {
    let memory = memories.get(runId);
    if (!memory) {
        if (memories.size >= 16) memories.delete(memories.keys().next().value!);
        memory = {
            dealt: hits.tally(),
            taken: hits.tally(),
            bows: hits.tally(),
            kills: hits.tally(),
            hitBy: new Map(),
            missing: new Map()
        };
        memories.set(runId, memory);
    }
    return memory;
}

const MISSED_LOOKS = 2;

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
    const box = run.arena!.box;
    const play = pi.playArea(layout, at);
    const now = ctx.now;
    const memory = memoryOf(run.id);
    const marker = run.marker;
    const floor = floorOf(run, now);
    const say = (line: string) => ctx.server.say([line]);
    const died = commands.readScores(await say(duel.READ_DIED));
    const dealt = commands.readScores(await say(duel.READ_DEALT));
    const taken = commands.readScores(await say(sw.READ_TAKEN));
    const bows = commands.readScores(await say(sw.READ_BOWS));
    const killed = commands.readScores(await say(duel.READ_KILLS));
    const here = new Map(
        commands.readWhere(await say(commands.IN_OVERWORLD)).map((one) => [lower(one.name), one])
    );
    const gone = new Set(
        commands.readWhere(await say(arena.readTagged(pi.GONE_TAG))).map((one) => lower(one.name))
    );
    const on = new Set(here.keys());
    const struck = hits.roseFor(memory.dealt, dealt, on);
    const hurt = hits.roseFor(memory.taken, taken, on);
    const drew = hits.roseFor(memory.bows, bows, on);
    const killedSince = hits.roseFor(memory.kills, killed, on);

    const before = pi.stateOf(run.game);
    const state: pi.PillarState = structuredClone(before);
    const isOut = (name: string) => state.out.some((one) => lower(one.name) === lower(name));
    const alive = () => run.entrants.filter((one) => !isOut(one.name));
    const placed = (name: string) => ({ ...here.get(lower(name))!, name });

    const hurtNow = alive().filter((one) => here.has(lower(one.name)) && hurt.has(lower(one.name)));
    const attackers = await hitsService.attackers(
        ctx,
        hurtNow.map((one) => one.name)
    );
    for (const one of hurtNow) {
        const victim = here.get(lower(one.name))!;
        const others = alive().filter(
            (other) => lower(other.name) !== lower(one.name) && here.has(lower(other.name))
        );
        const named = attackers.get(lower(one.name));
        const by =
            named !== undefined
                ? (others.find((other) => lower(other.name) === lower(named ?? ""))?.name ?? null)
                : sw.hitBy(
                      victim,
                      others
                          .filter((other) => struck.has(lower(other.name)))
                          .map((other) => placed(other.name)),
                      others
                          .filter((other) => drew.has(lower(other.name)))
                          .map((other) => placed(other.name))
                  );
        if (by) memory.hitBy.set(lower(one.name), { by, at: now });
    }

    for (const one of alive()) {
        const name = one.name;
        const where = here.get(lower(name));
        let why: pi.PillarState["out"][number]["why"] | null = null;
        if (!where) {
            const missed = (memory.missing.get(lower(name)) ?? 0) + 1;
            memory.missing.set(lower(name), missed);
            if (missed >= MISSED_LOOKS) why = "gone";
        } else {
            memory.missing.delete(lower(name));
            if ((died.get(name) ?? 0) > 0) why = "died";
            else if (floor > play.y1 && where.y < floor) why = "void";
            else if (gone.has(lower(name)) || !sw.inPlay(play, where))
                why = where.y < play.y1 || gone.has(lower(name)) ? "fell" : "left";
        }
        if (!why) continue;
        const hit = memory.hitBy.get(lower(name));
        const killer =
            hit && now - hit.at <= sw.CREDIT_MS
                ? hit.by
                : (alive().find(
                      (other) =>
                          lower(other.name) !== lower(name) && killedSince.has(lower(other.name))
                  )?.name ?? null);
        if (killer) state.kills[killer] = (state.kills[killer] ?? 0) + 1;
        state.out.push({ name, at: now, why });
        const left = alive().length;
        lines.push(
            `tag ${name} add ${pi.OUT_TAG}`,
            `tag ${name} remove ${pi.GONE_TAG}`,
            commands.say(
                messages.tag(language) + pillarMessages.outLine(name, why, killer, left, language)
            )
        );
        if (where) {
            lines.push(
                ...(marker ? pi.KIT_IDS.map((id) => arena.clearMarked(name, id, marker)) : []),
                `effect clear ${name}`,
                `effect give ${name} minecraft:instant_health 1 3 true`,
                `gamemode adventure ${name}`,
                arena.moveTo(name, pi.gallerySpot(layout, at, state.out.length - 1)),
                ...arena.titleTo(
                    name,
                    pillarMessages.outTitle(language),
                    pillarMessages.outSubtitle(language)
                )
            );
            if (why === "died") lines.push(`scoreboard players set ${name} ${duel.DIED} 0`);
        }
    }

    const left = alive();
    const decided = left.length <= 1 ? said.LAST_ONE : null;
    const readyAt = run.readyAt ?? now;

    if (!decided && marker) {
        // The pack's drops; or, where it is not on, the loop's, all in one batch.
        const pack = await hitsService.ensure(ctx);
        if (!pack) {
            const due = pi.dropsDue(readyAt, options.interval, now);
            const standing = left.filter((one) => here.has(lower(one.name))).map((one) => one.name);
            for (; state.drops < due; state.drops += 1)
                lines.push(...pi.dropLines(run.id, state.drops, standing, options.pool, marker));
        }
        if (options.twists)
            for (; state.twists < pi.twistsDue(readyAt, now); state.twists += 1) {
                const twist = pi.twistOf(run.id, state.twists);
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
                                  state.twists,
                                  left.map((one) => one.name),
                                  options.pool,
                                  marker
                              ))
                    );
            }
        if (floor > play.y1 && !state.rising) {
            state.rising = true;
            lines.push(commands.say(messages.tag(language) + pillarMessages.voidRising(language)));
        }
    }

    const gallery = pi.galleryFloor(layout, at);
    for (const [index, one] of run.entrants.entries()) {
        const where = here.get(lower(one.name));
        if (!where) continue;
        if (isOut(one.name)) {
            const seated =
                where.x >= gallery.x1 &&
                where.x < gallery.x2 + 1 &&
                where.z >= gallery.z1 &&
                where.z < gallery.z2 + 1 &&
                where.y >= gallery.y1;
            if (!seated)
                lines.push(
                    `gamemode adventure ${one.name}`,
                    arena.moveTo(one.name, pi.gallerySpot(layout, at, index))
                );
            lines.push(
                arena.protect(one.name),
                arena.feed(one.name),
                `effect give ${one.name} minecraft:weakness 3 100 true`,
                arena.actionbarTo(one.name, pillarMessages.galleryBar(language))
            );
            continue;
        }
        lines.push(
            arena.actionbarTo(
                one.name,
                pillarMessages.aliveBar(left.length, state.kills[one.name] ?? 0, language)
            )
        );
    }
    lines.push(
        `bossbar set ${commands.BAR} name ${commands.text(
            pillarMessages.bar(
                left.length,
                messages.clock((run.endsAt - now) / 1000),
                state.rising,
                language
            )
        )}`,
        ...arena.keepThrown(box)
    );
    if (JSON.stringify(state) !== JSON.stringify(before)) {
        const scores = sw.scoresOf(
            state,
            run.entrants.map((one) => one.name)
        );
        ctx.run = { ...ctx.run, game: state, points: Object.fromEntries(scores) };
        await ctx.persist();
    }
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
    kit: () => [...pi.KIT_IDS],
    // The events pack hands out the drops; put on before anything is built.
    hits: true,
    side: (_run, index) => index,
    spot: spotOf,
    respawn: (run) => pi.gallerySpot(layoutOf(run), atOf(run), 0),
    beginLines: () => sw.setupLines(),
    enterLines: (_run, one) => [
        `tag ${one.name} remove ${pi.OUT_TAG}`,
        `tag ${one.name} remove ${pi.GONE_TAG}`
    ],
    goLines,
    tick,
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
        return left.length === 1 && !disqualified.has(lower(left[0]!.name))
            ? [commands.say(pillarMessages.winner(left[0]!.name, language))]
            : [];
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
