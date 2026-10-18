/**
 * The part of a tick SkyWars and Pillars play alike (`sky-wars-service.ts`,
 * `pillars-service.ts`), last one standing on a build over a drop.
 *
 * Each tick reads damage dealt and taken, bows drawn, deaths, where everybody
 * is, and whom the quick look found past the play area; it credits each hit
 * to whoever the game says hurt them (from 1.19.4; nobody for a fall), or
 * before that to whoever struck nearest, or else whoever drew a bow; then puts
 * out whoever died, fell, left the play area, met a reason of the kind's own,
 * or has been off the server two looks running - their kit taken, up to the
 * gallery, the last to hit them in the last ten seconds credited - and keeps
 * whoever is out in the gallery, unhurt and unable to hurt.
 */

import * as hits from "./hits";
import * as arena from "./arena";
import * as sw from "./sky-wars";
import * as duel from "./team-duel";
import * as commands from "../commands";
import type * as stored from "../state";
import type * as speech from "../../speech";
import * as hitsService from "./hits-service";
import type { KindContext } from "./arena-game";

const lower = (name: string) => name.toLowerCase();

/** The reasons every kind here puts a player out for. */
export type Why = "fell" | "left" | "died" | "gone";

export interface Where {
    readonly name: string;
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

export interface Standing<W extends string> {
    out: { name: string; at: number; why: W }[];
    kills: Record<string, number>;
}

export interface Rules<W extends string> {
    readonly play: stored.Box;
    readonly gallery: stored.Box;
    /** The `index`th seat in the gallery. */
    seat(index: number): arena.Spot;
    readonly outTag: string;
    readonly goneTag: string;
    readonly kit: readonly string[];
    /** A reason of the kind's own, asked once a death is ruled out. */
    why?(name: string, where: Where): W | null;
    /** What else whoever is out is put through, on the server. */
    outLines?(name: string): string[];
    readonly said: {
        outLine(
            name: string,
            why: W,
            by: string | null,
            left: number,
            language: speech.Speech
        ): string;
        outTitle(language: speech.Speech): string;
        outSubtitle(language: speech.Speech): string;
        galleryBar(language: speech.Speech): string;
        aliveBar(left: number, kills: number, language: speech.Speech): string;
    };
    /** The tag line said before each line everybody reads. */
    readonly tag: string;
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
    /** Whoever is out and has been seen to the gallery with their kit taken. */
    settled: Set<string>;
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
            missing: new Map(),
            settled: new Set()
        };
        memories.set(runId, memory);
    }
    return memory;
}

/** Looks running a player may be off the server before they are out. */
const MISSED_LOOKS = 2;

/** Whoever is out made safe: tagged out, the kit taken, in adventure. */
function settleLines<W extends string>(
    name: string,
    marker: stored.Marker | null,
    rules: Rules<W>
) {
    return [
        `tag ${name} add ${rules.outTag}`,
        `tag ${name} remove ${rules.goneTag}`,
        ...(marker ? rules.kit.map((id) => arena.clearMarked(name, id, marker)) : []),
        ...(rules.outLines?.(name) ?? []),
        `gamemode adventure ${name}`
    ];
}

/**
 * One tick's look and its outs, into `state` and `lines`. Hands back where
 * everybody is and who is still in.
 */
export async function play<W extends string>(
    ctx: KindContext,
    lines: string[],
    state: Standing<W | Why>,
    rules: Rules<W | Why>
): Promise<{ here: Map<string, Where>; left: stored.Entrant[] }> {
    const run = ctx.run;
    const language = ctx.language;
    const now = ctx.now;
    const memory = memoryOf(run.id);
    const marker = run.marker;
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
        commands.readWhere(await say(arena.readTagged(rules.goneTag))).map((one) => lower(one.name))
    );
    // What rose since the last look; nothing on the first after a restart,
    // and a first score counted from 0.
    const on = new Set(here.keys());
    const struck = hits.roseFor(memory.dealt, dealt, on);
    const hurt = hits.roseFor(memory.taken, taken, on);
    const drew = hits.roseFor(memory.bows, bows, on);
    const killedSince = hits.roseFor(memory.kills, killed, on);

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

    // Out: dead, fallen, the kind's own reason, past the play area, or gone.
    for (const one of alive()) {
        const name = one.name;
        const where = here.get(lower(name));
        let why: W | Why | null = null;
        if (!where) {
            const missed = (memory.missing.get(lower(name)) ?? 0) + 1;
            memory.missing.set(lower(name), missed);
            if (missed >= MISSED_LOOKS) why = "gone";
        } else {
            memory.missing.delete(lower(name));
            if ((died.get(name) ?? 0) > 0) why = "died";
            else why = rules.why?.(name, where) ?? null;
            if (!why && (gone.has(lower(name)) || !sw.inPlay(rules.play, where)))
                why = where.y < rules.play.y1 || gone.has(lower(name)) ? "fell" : "left";
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
        lines.push(
            commands.say(
                rules.tag + rules.said.outLine(name, why, killer, alive().length, language)
            )
        );
        // Off the server, nothing reaches them: they are settled when back.
        if (!where) continue;
        memory.settled.add(lower(name));
        lines.push(
            ...settleLines(name, marker, rules),
            `effect give ${name} minecraft:instant_health 1 3 true`,
            arena.moveTo(name, rules.seat(state.out.length - 1)),
            ...arena.titleTo(name, rules.said.outTitle(language), rules.said.outSubtitle(language))
        );
        if (why === "died") lines.push(`scoreboard players set ${name} ${duel.DIED} 0`);
    }

    const left = alive();
    const gallery = rules.gallery;
    for (const [index, one] of run.entrants.entries()) {
        const where = here.get(lower(one.name));
        if (!where) continue;
        if (isOut(one.name)) {
            // Out while off the server, or before a restart: tagged and their
            // kit taken now, so nothing more is handed to them.
            if (!memory.settled.has(lower(one.name))) {
                memory.settled.add(lower(one.name));
                lines.push(...settleLines(one.name, marker, rules));
            }
            const seated =
                where.x >= gallery.x1 &&
                where.x < gallery.x2 + 1 &&
                where.z >= gallery.z1 &&
                where.z < gallery.z2 + 1 &&
                where.y >= gallery.y1;
            if (!seated)
                lines.push(
                    `gamemode adventure ${one.name}`,
                    arena.moveTo(one.name, rules.seat(index))
                );
            lines.push(
                arena.protect(one.name),
                arena.feed(one.name),
                `effect give ${one.name} minecraft:weakness 3 100 true`,
                arena.actionbarTo(one.name, rules.said.galleryBar(language))
            );
            continue;
        }
        lines.push(
            arena.actionbarTo(
                one.name,
                rules.said.aliveBar(left.length, state.kills[one.name] ?? 0, language)
            )
        );
    }
    return { here, left };
}

/** The state kept, and the scores with it, when the tick changed it. */
export async function keep(
    ctx: KindContext,
    state: sw.Standing,
    before: sw.Standing
): Promise<void> {
    if (JSON.stringify(state) === JSON.stringify(before)) return;
    const scores = sw.scoresOf(
        state,
        ctx.run.entrants.map((one) => one.name)
    );
    ctx.run = { ...ctx.run, game: state, points: Object.fromEntries(scores) };
    await ctx.persist();
}
