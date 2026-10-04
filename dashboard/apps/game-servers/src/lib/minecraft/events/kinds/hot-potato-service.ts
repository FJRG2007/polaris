/**
 * Playing hot potato (`hot-potato.ts`): the arena's own steps are
 * `arena-service`'s; this is its part of them.
 *
 * Each tick reads where everybody is and the hits since the last one - the
 * events data pack's (`hits.ts`), or the damage dealt and taken where the pack
 * is not on. In that order it then: puts out whoever has been gone from the
 * server two looks running; passes the potato when its holder struck and
 * somebody was hurt - by the holder, where the game says who hurt them, and
 * the nearest of them; sets off a fuse that has run out -
 * its holder out, to the gallery - and after a breath draws the next round's
 * holder. The rounds are written into the run before a tick ends, their times
 * as clock times, so a restart picks the fuse up where it was.
 */

import * as hits from "./hits";
import * as arena from "./arena";
import * as catalog from "../catalog";
import * as potato from "./hot-potato";
import * as speech from "../../speech";
import * as written from "../messages";
import * as commands from "../commands";
import type * as stored from "../state";
import * as hitsService from "./hits-service";
import * as said from "./hot-potato-messages";
import type { ArenaGame, ItemSyntax, KindContext } from "./arena-game";

const messages = speech.spoken(written);
const potatoMessages = speech.spoken(said);

const lower = (name: string) => name.toLowerCase();

function optionsOf(run: stored.EventRun): catalog.EventOptions<"hot-potato"> {
    return run.preset.options as catalog.EventOptions<"hot-potato">;
}

/** What one run keeps between ticks: nothing that must survive a restart. */
interface Memory {
    dealt: hits.Tally;
    taken: hits.Tally;
    /** Looks running each player was not on the server. */
    missing: Map<string, number>;
}

const memories = new Map<string, Memory>();

function memoryOf(runId: string): Memory {
    let memory = memories.get(runId);
    if (!memory) {
        if (memories.size >= 16) memories.delete(memories.keys().next().value!);
        memory = { dealt: hits.tally(), taken: hits.tally(), missing: new Map() };
        memories.set(runId, memory);
    }
    return memory;
}

/** Looks running a player may be off the server before they are out. */
const MISSED_LOOKS = 2;

/** The first round, as "Go!" left it: its holder drawn, its fuse lit then. */
function firstRound(run: stored.EventRun, now: number): potato.PotatoState {
    const start = run.readyAt ?? now;
    return potato.stateSchema.parse({
        round: 1,
        holder: potato.holderFor(
            run.id,
            1,
            run.entrants.map((one) => one.name)
        ),
        fuseEndsAt: start + optionsOf(run).fuseSeconds * 1000,
        passedAt: start
    });
}

/** Handed the potato: on their head, glowing, told so - and still weak, until
 *  the tick after next frees them to pass it (`potato.canPass`). */
function handedLines(
    name: string,
    marker: stored.Marker | null,
    itemCommand: boolean,
    language: speech.Speech
): string[] {
    return [
        ...(marker ? [arena.wearMarked(name, potato.POTATO, marker, itemCommand)] : []),
        `effect give ${name} minecraft:glowing 3 0 true`,
        ...arena.titleTo(
            name,
            potatoMessages.holderTitle(language),
            potatoMessages.holderSubtitle(language)
        ),
        `execute as ${name} at @s run playsound minecraft:entity.creeper.primed master @s ~ ~ ~ 1 1`
    ];
}

/** No longer holding it: the potato taken off their head, the glow off. */
function takenLines(name: string, marker: stored.Marker | null): string[] {
    return [
        ...(marker ? [arena.clearMarked(name, potato.POTATO, marker)] : []),
        ...potato.unheldLines(name)
    ];
}

function spotOf(run: stored.EventRun, entrant: stored.Entrant): arena.Spot {
    return potato.startSpot(run.arena!.box, entrant.side, Math.max(1, run.joined.length));
}

async function goLines(ctx: KindContext, syntax: ItemSyntax): Promise<string[]> {
    const run = ctx.run;
    const first = firstRound(run, ctx.now);
    const out: string[] = [];
    for (const one of run.entrants)
        out.push(
            arena.moveTo(one.name, spotOf(run, one)),
            ...arena.titleTo(
                one.name,
                potatoMessages.goTitle(ctx.language),
                potatoMessages.goSubtitle(ctx.language)
            )
        );
    if (first.holder) {
        out.push(
            ...handedLines(first.holder, syntax.marker, syntax.itemCommand, ctx.language),
            commands.say(
                messages.tag(ctx.language) + potatoMessages.roundLine(1, first.holder, ctx.language)
            )
        );
    }
    return out;
}

async function tick(ctx: KindContext, lines: string[]): Promise<string | null> {
    const run = ctx.run;
    const language = ctx.language;
    const options = optionsOf(run);
    const box = run.arena!.box;
    const now = ctx.now;
    const memory = memoryOf(run.id);
    const marker = run.marker;
    const itemCommand = await ctx.atLeast([1, 17]);
    const say = (line: string) => ctx.server.say([line]);
    const here = new Map(
        commands.readWhere(await say(commands.IN_OVERWORLD)).map((one) => [lower(one.name), one])
    );
    // Who struck, and who was hurt, since the last look: the pack's, or else
    // what the damage counts say - nothing on the first look after a restart.
    const taken = await hitsService.take(ctx);
    const on = new Set(here.keys());
    const struck =
        taken?.struck ??
        hits.roseFor(memory.dealt, commands.readScores(await say(potato.READ_DEALT)), on);
    const hurt =
        taken?.hurt ??
        hits.roseFor(memory.taken, commands.readScores(await say(potato.READ_TAKEN)), on);

    const before = potato.stateOf(run.game);
    const state = structuredClone(before ?? firstRound(run, now));
    const isOut = (name: string) => state.out.some((one) => lower(one.name) === lower(name));
    const alive = () => run.entrants.filter((one) => !isOut(one.name));
    /** Out now: off the potato if they held it, the round over if they did. */
    const putOut = (name: string) => {
        state.out.push({ name, round: state.round, at: now });
        if (state.holder && lower(state.holder) === lower(name)) {
            lines.push(...takenLines(name, marker));
            state.holder = null;
            state.fuseEndsAt = null;
            state.pauseUntil = now + potato.ROUND_PAUSE_MS;
        }
    };

    // Gone from the server two looks running: out, or nobody could ever get
    // the potato to them.
    for (const one of alive()) {
        if (here.has(lower(one.name))) {
            memory.missing.delete(lower(one.name));
            continue;
        }
        const missed = (memory.missing.get(lower(one.name)) ?? 0) + 1;
        memory.missing.set(lower(one.name), missed);
        if (missed < MISSED_LOOKS) continue;
        putOut(one.name);
        lines.push(
            commands.say(messages.tag(language) + potatoMessages.leftGame(one.name, language))
        );
    }

    // Passed: the holder struck and somebody was hurt - by the holder, where
    // the game says who hurt them - the nearest of them.
    const holder = state.holder;
    if (
        holder &&
        state.pauseUntil === null &&
        potato.canPass(state, now) &&
        struck.has(lower(holder))
    ) {
        const from = here.get(lower(holder));
        const victims = alive().filter(
            (one) =>
                lower(one.name) !== lower(holder) &&
                hurt.has(lower(one.name)) &&
                here.has(lower(one.name))
        );
        const by = await hitsService.attackers(
            ctx,
            victims.map((one) => one.name)
        );
        const hit = from
            ? potato.hitBy(
                  from,
                  victims
                      .filter((one) => potato.hurtByHolder(by.get(lower(one.name)), holder))
                      .map((one) => ({ ...here.get(lower(one.name))!, name: one.name }))
              )
            : null;
        if (hit) {
            lines.push(
                ...takenLines(holder, marker),
                ...handedLines(hit, marker, itemCommand, language),
                commands.say(messages.tag(language) + potatoMessages.passed(holder, hit, language))
            );
            state.holder = hit;
            state.passedAt = now;
        }
    }

    // The fuse out: whoever holds it is out, with a bang and nothing broken.
    if (state.holder && state.fuseEndsAt !== null && now >= state.fuseEndsAt) {
        const name = state.holder;
        const at = here.get(lower(name));
        if (at) lines.push(...potato.boomLines(at));
        putOut(name);
        lines.push(
            arena.moveTo(name, potato.gallerySpot(box, state.out.length - 1)),
            ...arena.titleTo(
                name,
                potatoMessages.outTitle(language),
                potatoMessages.outSubtitle(language)
            ),
            commands.say(
                messages.tag(language) + potatoMessages.exploded(name, alive().length, language)
            )
        );
    }

    let decided: string | null = null;
    const left = alive();
    if (left.length <= 1) {
        if (left[0])
            lines.push(
                commands.say(
                    messages.tag(language) + potatoMessages.winner(left[0].name, language)
                ),
                commands.sound(commands.SOUNDS.win)
            );
        decided = said.LAST_ONE;
    } else if (state.holder === null && (state.pauseUntil ?? 0) <= now) {
        // The next round, after the breath: a new holder, a new fuse.
        state.round += state.pauseUntil === null ? 0 : 1;
        state.holder = potato.holderFor(
            run.id,
            state.round,
            left.map((one) => one.name)
        );
        state.fuseEndsAt = now + options.fuseSeconds * 1000;
        state.passedAt = now;
        state.pauseUntil = null;
        if (state.holder)
            lines.push(
                ...handedLines(state.holder, marker, itemCommand, language),
                commands.say(
                    messages.tag(language) +
                        potatoMessages.roundLine(state.round, state.holder, language)
                ),
                commands.sound(commands.SOUNDS.start)
            );
    }

    // Nobody hurt; everybody but a holder free to pass it unable to hurt; the
    // ones out kept in the gallery, the rest on the platform.
    const fuseLeft = state.fuseEndsAt === null ? 0 : (state.fuseEndsAt - now) / 1000;
    const gallery = potato.galleryOf(box);
    for (const [index, one] of run.entrants.entries()) {
        const at = here.get(lower(one.name));
        if (!at) continue;
        lines.push(...potato.unhurtLines(one.name));
        if (isOut(one.name)) {
            const seated =
                at.x >= gallery.x1 &&
                at.x < gallery.x2 + 1 &&
                at.z >= gallery.z1 &&
                at.z < gallery.z2 + 1;
            if (!seated) lines.push(arena.moveTo(one.name, potato.gallerySpot(box, index)));
            lines.push(
                potato.weakLine(one.name),
                arena.actionbarTo(one.name, potatoMessages.galleryBar(language))
            );
            continue;
        }
        if (!potato.onPlatform(box, at)) lines.push(arena.moveTo(one.name, spotOf(run, one)));
        const holding = state.holder !== null && lower(state.holder) === lower(one.name);
        if (holding && potato.canPass(state, now)) lines.push(...potato.holderLines(one.name));
        else lines.push(potato.weakLine(one.name));
        if (holding) {
            const tick = potato.fuseLine(one.name, fuseLeft);
            if (tick) lines.push(tick);
        }
        lines.push(
            arena.actionbarTo(
                one.name,
                state.holder === null
                    ? potatoMessages.nextRoundBar(language)
                    : holding
                      ? potatoMessages.holdingBar(fuseLeft, language)
                      : potatoMessages.awayBar(state.holder, fuseLeft, language)
            )
        );
    }
    lines.push(
        `bossbar set ${commands.BAR} name ${commands.text(
            potatoMessages.bar(state.round, state.holder, Math.max(0, fuseLeft), language)
        )}`,
        ...arena.keepThrown(box)
    );
    if (JSON.stringify(state) !== JSON.stringify(before)) {
        const scores = potato.scoresOf(
            state,
            run.entrants.map((one) => one.name)
        );
        ctx.run = { ...ctx.run, game: state, points: Object.fromEntries(scores) };
        await ctx.persist();
    }
    return decided;
}

export const hotPotato: ArenaGame = {
    most: () => potato.MOST,
    reach: (run) => potato.reachOf(run.joined.length),
    box: (run, place) => potato.platformBox(place, place.y + arena.ALTITUDE, run.joined.length),
    fills: (_run, box) => potato.platformFills(box),
    blocks: () => [...potato.PLATFORM_BLOCKS],
    kit: () => [potato.POTATO],
    hits: true,
    side: (_run, index) => index,
    spot: spotOf,
    beginLines: () => potato.setupLines(),
    goLines,
    tick,
    results: (run) =>
        potato.scoresOf(
            potato.stateOf(run.game),
            run.entrants.map((one) => one.name)
        ),
    resultLines: (run, language) => {
        const state = potato.stateOf(run.game);
        const left = run.entrants.filter(
            (one) => !state?.out.some((out) => lower(out.name) === lower(one.name))
        );
        return left.length === 1
            ? [commands.say(potatoMessages.winner(left[0]!.name, language))]
            : [];
    },
    endLines: () => [...potato.TEARDOWN]
};
