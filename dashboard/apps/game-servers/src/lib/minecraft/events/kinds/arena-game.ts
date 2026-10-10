/**
 * What one kind played in an arena has to say for itself, so the arena's own
 * steps - joined, enrolled, a box proved empty and built, everybody stashed and
 * brought in, the wait for them, 3-2-1, "Go!", the play and `closeArena` - are
 * written once (`arena-service.ts`) and every kind only fills in its own part.
 *
 * A kind lives in two files: `<kind>.ts`, pure, with its map, its commands and
 * its maths, and `<kind>-service.ts`, which runs a tick of it against the
 * server and hands the arena an `ArenaGame`. The registry is `arena-games.ts`.
 *
 * The team duel, the build battle and the king of the ring were written before
 * this and still have their own branches in `arena-service`; they keep them.
 */

import type { Spot } from "./arena";
import type * as stored from "../state";
import type * as catalog from "../catalog";
import type * as speech from "../../speech";
import type { PlaceRefusal } from "../place-search";
import type * as stashService from "./stash-service";
import type { ServerContainer } from "../../service";

/** One line somebody said in the chat. */
export interface Said {
    readonly name: string;
    readonly text: string;
}

/** What the loop lends one of these events for a tick. */
export interface KindContext {
    readonly server: ServerContainer;
    /** Every language: each line is split for its readers on the way out. */
    readonly language: speech.Speech;
    /** The server's own: what is written once for everybody (the teams' names). */
    readonly home: catalog.Language;
    readonly now: number;
    /** The run as the loop holds it; set to change it. */
    run: stored.EventRun;
    persist(): Promise<void>;
    findPlace(
        place: catalog.EventPlace,
        distance: number,
        radius: number,
        /** `air` for what is built in the air: over anything, only its air counts. */
        surface?: "ground" | "open" | "air",
        /** Whether, after a few tries, it may come in closer and near a home. */
        nearHome?: boolean,
        /** For `air`: how far over the highest thing in its footprint. */
        lift?: number
    ): Promise<stored.Point | "failed" | null>;
    /**
     * Where the beam up to something in the sky stands (`beam-entry.ts`): open,
     * flat ground nearest the players - or, with nobody in the Overworld,
     * nearest `near`. `none` when there is nowhere like that, `unknown` when
     * the ground could not be read at all.
     */
    findEntry(near: { x: number; z: number }): Promise<stored.Point | "none" | "unknown">;
    /** The place given up, for the reason given, and another looked for; throws
     *  once the tries run out. */
    giveUpPlace(point: stored.Point, why?: PlaceRefusal): Promise<void>;
    /** What was said since the last time this was asked; null the first time. */
    chat(): Promise<readonly Said[] | null>;
    atLeast(version: readonly number[]): Promise<boolean>;
    /** Who, in lower case, is still owed a trip back from an earlier arena. */
    owed(): Promise<ReadonlySet<string>>;
    /** Whose run a kept bag belongs to, for its database copy. */
    readonly stashOwner: stashService.StashOwner;
    /** How long one tick is, in seconds: what a second in the circle is counted by. */
    readonly tickSeconds: number;
}

/** The event cannot go on, for the reason given. */
export class EventStopped extends Error {}

/** Not enough players joined for it to go ahead: called off, which is nobody's
 *  failure - as a spleef with one player is. */
export class TooFew extends EventStopped {}

/** One block kind filled into one box, only where there is air. */
export interface Fill {
    readonly box: stored.Box;
    readonly block: string;
}

/** How this server writes what a kind puts in a chest or on a head. */
export interface ItemSyntax {
    /** How the kit is marked: components from 1.20.5, a tag before. */
    readonly marker: stored.Marker;
    /** `item replace` from 1.17; `replaceitem` before it. */
    readonly itemCommand: boolean;
}

export interface ArenaGame {
    /** The most players it takes; whoever joined past them is told it is full. */
    most(run: stored.EventRun): number;
    /** How far from its center the ground under it is judged. */
    reach(run: stored.EventRun): number;
    /** The box it takes over the highest thing found under it (`place`). */
    box(run: stored.EventRun, place: stored.Point): stored.Box;
    /** What it is built of, in order, each only into air. The last fill's first
     *  corner is what is probed afterwards to prove the blocks stayed. */
    fills(run: stored.EventRun, box: stored.Box): Fill[];
    /** Every block kind that can be in its box while it stands - what it built
     *  and what players can place - as bare ids, for taking it down. */
    blocks(run: stored.EventRun, box: stored.Box): string[];
    /** The kind's own state as it is built, written with the arena: the
     *  version of its layout, so a run built before an update keeps it. */
    built?(run: stored.EventRun): Record<string, unknown>;
    /** What the kind asks the server before it builds - what its version can
     *  show - kept in the run's game state for `fills` and `built` to read. */
    prepare?(ctx: KindContext): Promise<Record<string, unknown>>;
    /** Lines run once the fills are in: what a chest holds, say. */
    decorate?(run: stored.EventRun, box: stored.Box, syntax: ItemSyntax): string[];
    /** Every item it hands out, marked, for taking back. */
    kit(run: stored.EventRun): string[];
    /** Two when it is played by two teams: both must have somebody in it. */
    readonly teams?: number;
    /** Whether it reads hits off the events data pack (`hits.ts`): the pack is
     *  put on before anything is built, while taking it in pauses nobody's game. */
    readonly hits?: boolean;
    /** The side the `index`th of those who joined plays on. */
    side(run: stored.EventRun, index: number): number;
    /** Where an entrant stands at "Go!" and is put back to while waiting. */
    spot(run: stored.EventRun, entrant: stored.Entrant): Spot;
    /** Where an entrant who dies comes back, for a kind played on past a
     *  death: their spawn point there for as long as they are in. */
    respawn?(run: stored.EventRun, entrant: stored.Entrant): Spot;
    /** Said once as the event begins, before anybody is brought in (teams,
     *  counts), in the server's own language. */
    beginLines?(preset: catalog.EventPreset, language: catalog.Language): string[];
    /** Besides `arena.enter`, as each player is brought in. */
    enterLines?(run: stored.EventRun, entrant: stored.Entrant): string[];
    /** Every look while everybody is waited for. */
    holdLines?(run: stored.EventRun): string[];
    /** "Go!": everybody on their spot, the kit handed out, what to do on screen. */
    goLines(ctx: KindContext, syntax: ItemSyntax): Promise<string[]>;
    /** One tick of play; a sentence when it is decided before its time is up. */
    tick(ctx: KindContext, lines: string[]): Promise<string | null>;
    /** Sent far oftener than the tick (`events-service` quick look), nothing read. */
    quickLines?(run: stored.EventRun): string[];
    /** The final scores, by name. */
    results(run: stored.EventRun): Map<string, number>;
    /** What breaks a tie on score, the lower the better (`plan.podium`). */
    tiebreak?(run: stored.EventRun): Record<string, number>;
    /** Said with the results. */
    resultLines(run: stored.EventRun, language: speech.Speech): string[];
    /** Its teams and counts removed, with the rest of the event's own. */
    endLines?(run: stored.EventRun): string[];
    /**
     * What of the end is one player's own and must still reach them if they
     * were not on when it ended (`stored.OwedLines`): sent when they are next
     * seen. Empty for nothing owed.
     */
    owedLines?(run: stored.EventRun, name: string): { reason: string; lines: string[] }[];
    /** What is left lying in its box once everybody is out: arrows, say. */
    closeLines?(box: stored.Box): string[];
}
