/**
 * How deals move through the stages: for each stage, how many deals reached
 * it, how long they stayed, and how many of those were won in the end; then
 * the deals won and lost, and the reasons given for each.
 *
 * A deal's path is read from its activity log: every logged change of its
 * stage is one move. A deal starts in the stage its first move left, or the
 * one it is in now if it never moved, from the day it was made.
 *
 * Pure and client-safe: the server feeds it rows, the screen reads it.
 */

import { WON_STAGE } from "./forecast";
import { z } from "zod";
import { readChanges } from "./timeline";
import { OPPORTUNITY_STAGES, type OpportunityStage } from "./objects";

/** The stage a deal is lost at. */
export const LOST_STAGE: OpportunityStage = "lost";

const DAY = 86_400_000;

/** One deal as it is now. */
export interface FlowDeal {
    readonly id: string;
    readonly stage: string;
    readonly createdAt: Date;
}

/** One logged event of a deal that touched its stage. */
export interface FlowEvent {
    readonly recordId: string;
    readonly at: Date;
    /** The event's stored changes, as `CrmEvent.changes` keeps them. */
    readonly changes: string;
}

/** Deals that ended won or lost with one reason, as the database counted them. */
export interface ReasonRow {
    readonly stage: string;
    readonly reason: string;
    readonly deals: number;
}

export interface StageStep {
    readonly stage: OpportunityStage;
    /** Deals that were ever at this stage. */
    readonly reached: number;
    /** Of those, the ones won by now. */
    readonly won: number;
    /** Deals at this stage right now. */
    readonly now: number;
    /** Average days a deal stayed before it moved on; null when none has. */
    readonly averageDays: number | null;
}

export interface ReasonCount {
    /** As first written; "" when no reason was given. */
    readonly reason: string;
    readonly deals: number;
}

export interface StageFlow {
    readonly steps: StageStep[];
    readonly won: number;
    readonly lost: number;
    /** Won out of everything decided, as a whole percent; null before any is. */
    readonly winRate: number | null;
    readonly wonReasons: ReasonCount[];
    readonly lostReasons: ReasonCount[];
    /** Some deals or moves were left out: more than one reading holds. */
    readonly capped: boolean;
}

function isStage(value: unknown): value is OpportunityStage {
    return typeof value === "string" && (OPPORTUNITY_STAGES as readonly string[]).includes(value);
}

interface Move {
    readonly at: number;
    readonly from: OpportunityStage | null;
    readonly to: OpportunityStage;
}

/** The stage moves in a deal's events, oldest first. */
function movesOf(events: readonly FlowEvent[]): Move[] {
    const moves: Move[] = [];
    for (const event of events) {
        const change = readChanges(event.changes).find((entry) => entry.key === "stage");
        if (!change || !isStage(change.after)) continue;
        moves.push({
            at: event.at.getTime(),
            from: isStage(change.before) ? change.before : null,
            to: change.after
        });
    }
    return moves.sort((a, b) => a.at - b.at);
}

/** Reasons counted together whatever their case or spacing, the most given first. */
export function countReasons(rows: readonly ReasonRow[], stage: string): ReasonCount[] {
    const counts = new Map<string, { reason: string; deals: number }>();
    for (const row of rows) {
        if (row.stage !== stage) continue;
        const reason = row.reason.trim().replace(/\s+/g, " ");
        const key = reason.toLocaleLowerCase();
        const entry = counts.get(key) ?? { reason, deals: 0 };
        entry.deals += row.deals;
        counts.set(key, entry);
    }
    return [...counts.values()].sort(
        (a, b) => b.deals - a.deals || a.reason.localeCompare(b.reason)
    );
}

export function buildStageFlow(
    deals: readonly FlowDeal[],
    events: readonly FlowEvent[],
    reasons: readonly ReasonRow[],
    capped = false
): StageFlow {
    const byDeal = new Map<string, FlowEvent[]>();
    for (const event of events) {
        const list = byDeal.get(event.recordId);
        if (list) list.push(event);
        else byDeal.set(event.recordId, [event]);
    }
    const reached = new Map<OpportunityStage, Set<string>>();
    const stays = new Map<OpportunityStage, number[]>();
    const now = new Map<OpportunityStage, number>();
    const reach = (stage: OpportunityStage, id: string) => {
        const set = reached.get(stage) ?? new Set<string>();
        set.add(id);
        reached.set(stage, set);
    };
    const wonIds = new Set<string>();
    for (const deal of deals) {
        if (!isStage(deal.stage)) continue;
        now.set(deal.stage, (now.get(deal.stage) ?? 0) + 1);
        if (deal.stage === WON_STAGE) wonIds.add(deal.id);
        const moves = movesOf(byDeal.get(deal.id) ?? []);
        let stage: OpportunityStage = moves[0]?.from ?? moves[0]?.to ?? deal.stage;
        let since = deal.createdAt.getTime();
        reach(stage, deal.id);
        for (const move of moves) {
            // A deal made at a stage logs it as a move from nothing.
            if (move.from === null && move.to === stage) continue;
            if (move.to === stage) continue;
            const list = stays.get(stage) ?? [];
            list.push(Math.max(0, move.at - since) / DAY);
            stays.set(stage, list);
            stage = move.to;
            since = move.at;
            reach(stage, deal.id);
        }
    }
    const steps = OPPORTUNITY_STAGES.filter((stage) => stage !== LOST_STAGE).map((stage) => {
        const ids = reached.get(stage) ?? new Set<string>();
        const days = stays.get(stage) ?? [];
        return {
            stage,
            reached: ids.size,
            won: [...ids].filter((id) => wonIds.has(id)).length,
            now: now.get(stage) ?? 0,
            averageDays:
                days.length === 0
                    ? null
                    : Math.round((days.reduce((sum, value) => sum + value, 0) / days.length) * 10) /
                      10
        };
    });
    const won = now.get(WON_STAGE) ?? 0;
    const lost = now.get(LOST_STAGE) ?? 0;
    return {
        steps,
        won,
        lost,
        winRate: won + lost === 0 ? null : Math.round((won / (won + lost)) * 100),
        wonReasons: countReasons(reasons, WON_STAGE),
        lostReasons: countReasons(reasons, LOST_STAGE),
        capped
    };
}

export const stageFlowInputSchema = z.object({ mine: z.boolean() }).strict();
