/**
 * Playing SkyWars (`sky-wars.ts`): the arena's own steps are `arena-service`'s;
 * this is its part of them.
 *
 * Built, the islands' chests are filled (`decorate`), each item marked as the
 * kit. At "Go!" the cages come down. Each tick reads health, damage dealt and
 * taken, bows drawn, deaths, where everybody is, and whom the quick look found
 * past the play area; it credits each hit to whoever the game says hurt them
 * (from 1.19.4; nobody for a fall), or before that to whoever struck nearest,
 * or else whoever drew a bow; then puts out whoever is down to `OUT_HEALTH`, died, fell
 * under the islands or left the play area, or has been off the server two
 * looks running - their kit taken, up to the gallery, the last to hit them in
 * the last ten seconds credited. The last one left wins.
 */

import * as hits from "./hits";
import * as arena from "./arena";
import * as sw from "./sky-wars";
import * as duel from "./team-duel";
import * as catalog from "../catalog";
import * as speech from "../../speech";
import * as written from "../messages";
import * as commands from "../commands";
import type * as stored from "../state";
import * as said from "./sky-wars-messages";
import * as hitsService from "./hits-service";
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

/** What one run keeps between ticks: nothing that must survive a restart. */
interface Memory {
    dealt: hits.Tally;
    taken: hits.Tally;
    bows: hits.Tally;
    kills: hits.Tally;
    /** Who last hit each player, and when. */
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

/** Looks running a player may be off the server before they are out. */
const MISSED_LOOKS = 2;

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
    // Islands broken by hand: survival, but only when nothing broken drops
    // (`sw.TILE_DROPS`), so nothing unmarked is carried home.
    if (sw.TILE_DROPS.some((rule) => run.gamerules[rule] !== undefined))
        for (const one of run.entrants) out.push(`gamemode survival ${one.name}`);
    // The cages down last, everybody already on their own spot.
    out.push(...sw.cagesDown(layoutOf(run), atOf(run)));
    return out;
}

async function tick(ctx: KindContext, lines: string[]): Promise<string | null> {
    const run = ctx.run;
    const language = ctx.language;
    const layout = layoutOf(run);
    const at = atOf(run);
    const box = run.arena!.box;
    const play = sw.playArea(layout, at);
    const now = ctx.now;
    const memory = memoryOf(run.id);
    const marker = run.marker;
    const say = (line: string) => ctx.server.say([line]);
    const health = commands.readScores(await say(duel.READ_HP));
    const died = commands.readScores(await say(duel.READ_DIED));
    const dealt = commands.readScores(await say(duel.READ_DEALT));
    const taken = commands.readScores(await say(sw.READ_TAKEN));
    const bows = commands.readScores(await say(sw.READ_BOWS));
    const killed = commands.readScores(await say(duel.READ_KILLS));
    const here = new Map(
        commands.readWhere(await say(commands.IN_OVERWORLD)).map((one) => [lower(one.name), one])
    );
    const gone = new Set(
        commands.readWhere(await say(arena.readTagged(sw.GONE_TAG))).map((one) => lower(one.name))
    );
    // What rose since the last look; nothing on the first after a restart,
    // and a first score counted from 0.
    const on = new Set(here.keys());
    const struck = hits.roseFor(memory.dealt, dealt, on);
    const hurt = hits.roseFor(memory.taken, taken, on);
    const drew = hits.roseFor(memory.bows, bows, on);
    const killedSince = hits.roseFor(memory.kills, killed, on);

    const before = sw.stateOf(run.game);
    const state: sw.WarState = structuredClone(before);
    const isOut = (name: string) => state.out.some((one) => lower(one.name) === lower(name));
    const alive = () => run.entrants.filter((one) => !isOut(one.name));
    const placed = (name: string) => ({ ...here.get(lower(name))!, name });

    // Each hit credited to whoever the game says hurt them (from 1.19.4) -
    // nobody, for a fall or a fire - or before that to whoever struck nearest,
    // or else drew a bow.
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

    // Out: brought low, dead, fallen, past the play area, or gone.
    for (const one of alive()) {
        const name = one.name;
        const where = here.get(lower(name));
        let why: sw.WarState["out"][number]["why"] | null = null;
        if (!where) {
            const missed = (memory.missing.get(lower(name)) ?? 0) + 1;
            memory.missing.set(lower(name), missed);
            if (missed >= MISSED_LOOKS) why = "gone";
        } else {
            memory.missing.delete(lower(name));
            const hp = health.get(name);
            if ((died.get(name) ?? 0) > 0) why = "died";
            else if (hp !== undefined && hp > 0 && hp <= sw.OUT_HEALTH) why = "low";
            else if (gone.has(lower(name)) || !sw.inPlay(play, where))
                why = where.y < play.y1 || gone.has(lower(name)) ? "fell" : "left";
        }
        if (!why) continue;
        const hit = memory.hitBy.get(lower(name));
        const killer =
            hit && now - hit.at <= sw.CREDIT_MS
                ? hit.by
                : // A kill the game counted for a rival since the last look.
                  (alive().find(
                      (other) =>
                          lower(other.name) !== lower(name) && killedSince.has(lower(other.name))
                  )?.name ?? null);
        if (killer) state.kills[killer] = (state.kills[killer] ?? 0) + 1;
        state.out.push({ name, at: now, why });
        const left = alive().length;
        lines.push(
            `tag ${name} add ${sw.OUT_TAG}`,
            `tag ${name} remove ${sw.GONE_TAG}`,
            commands.say(
                messages.tag(language) + warMessages.outLine(name, why, killer, left, language)
            )
        );
        if (where) {
            lines.push(
                ...(marker ? sw.LOOT_IDS.map((id) => arena.clearMarked(name, id, marker)) : []),
                `effect give ${name} minecraft:instant_health 1 3 true`,
                `gamemode adventure ${name}`,
                arena.moveTo(name, sw.gallerySpot(layout, at, state.out.length - 1)),
                ...arena.titleTo(
                    name,
                    warMessages.outTitle(language),
                    warMessages.outSubtitle(language)
                )
            );
            if (why === "died") lines.push(`scoreboard players set ${name} ${duel.DIED} 0`);
        }
    }

    let decided: string | null = null;
    const left = alive();
    if (left.length <= 1) {
        if (left[0])
            lines.push(
                commands.say(messages.tag(language) + warMessages.winner(left[0].name, language)),
                commands.sound(commands.SOUNDS.win)
            );
        decided = said.LAST_ONE;
    }

    // Whoever is out kept in the gallery, unhurt and unable to hurt.
    const gallery = sw.galleryFloor(layout, at);
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
            // Nothing broken from the gallery: back in adventure, whoever was
            // out while off the server included.
            if (!seated)
                lines.push(
                    `gamemode adventure ${one.name}`,
                    arena.moveTo(one.name, sw.gallerySpot(layout, at, index))
                );
            lines.push(
                arena.protect(one.name),
                arena.feed(one.name),
                `effect give ${one.name} minecraft:weakness 3 100 true`,
                arena.actionbarTo(one.name, warMessages.galleryBar(language))
            );
            continue;
        }
        lines.push(
            arena.actionbarTo(
                one.name,
                warMessages.aliveBar(left.length, state.kills[one.name] ?? 0, language)
            )
        );
    }
    lines.push(
        `bossbar set ${commands.BAR} name ${commands.text(
            warMessages.bar(left.length, messages.clock((run.endsAt - now) / 1000), language)
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

export const skyWars: ArenaGame = {
    most: () => sw.MOST,
    reach: (run) => sw.reachOf(layoutOf(run)),
    box: (run, place) => sw.arenaBox(layoutOf(run), atOf(run, place)),
    built: () => ({ design: sw.DESIGN }),
    fills: (run) => sw.arenaFills(layoutOf(run), atOf(run)),
    blocks: () => [...sw.ARENA_BLOCKS],
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
    beginLines: () => sw.setupLines(),
    enterLines: (_run, one) => [
        `tag ${one.name} remove ${sw.OUT_TAG}`,
        `tag ${one.name} remove ${sw.GONE_TAG}`
    ],
    goLines,
    tick,
    quickLines: (run) => sw.quickLines(layoutOf(run), atOf(run), run.arena!.box),
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
    resultLines: (run, language) => {
        const state = sw.stateOf(run.game);
        const left = run.entrants.filter(
            (one) => !state.out.some((out) => lower(out.name) === lower(one.name))
        );
        return left.length === 1 ? [commands.say(warMessages.winner(left[0]!.name, language))] : [];
    },
    endLines: () => [...sw.TEARDOWN],
    closeLines: (box) =>
        ["arrow", "snowball", "ender_pearl"].map(
            (type) =>
                `execute in minecraft:overworld run kill @e[type=minecraft:${type},${arena.within(box)}]`
        )
};
