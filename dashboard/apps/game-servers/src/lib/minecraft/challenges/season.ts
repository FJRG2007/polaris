/**
 * The season pass and the streak: what finishing challenges adds up to.
 *
 * Built against the treadmill battle passes are resented for:
 * - a daily cap on points, so nobody outpaces the pass by playing all day;
 * - the last two weeks pay half as much again to anybody below the middle tier;
 * - a broken streak falls back to its last milestone, not to zero, and one
 *   missed day a week is forgiven outright;
 * - somebody back after a week away gets a welcome bonus on their first one.
 *
 * Items come only at the milestone tiers, where the operator sees the season's
 * whole item budget in one table; every other tier gives levels.
 *
 * Pure.
 */

import * as period from "./period";
import * as catalog from "./catalog";
import type { Ledger } from "./state";
import type { ChallengeSettings, Payout } from "./settings";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The tier a number of points is at. */
export function tierOf(points: number, settings: ChallengeSettings): number {
    return Math.min(settings.season.tiers, Math.floor(points / settings.season.pointsPerTier));
}

/** Whether the catch-up multiplier applies to a player now. */
export function catchUpApplies(
    settings: ChallengeSettings,
    season: period.Season,
    tier: number,
    medianTier: number
): boolean {
    return settings.season.catchUp && season.daysLeft <= 14 && tier < medianTier;
}

/** The middle tier among players who have any points this season. */
export function medianTier(tiers: readonly number[]): number {
    const sorted = tiers.filter((tier) => tier > 0).sort((left, right) => left - right);
    if (sorted.length === 0) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export interface Earned {
    readonly ledger: Ledger;
    /** Points actually added after the multiplier and the cap. */
    readonly granted: number;
    /** Tiers crossed by this, each owed its reward. */
    readonly tiers: readonly number[];
}

/**
 * Points added to a ledger: times the catch-up multiplier, held to what is
 * left of today's cap, and every tier they cross.
 */
export function addPoints(
    ledger: Ledger,
    amount: number,
    day: string,
    settings: ChallengeSettings,
    catchUp: boolean
): Earned {
    if (amount <= 0) return { ledger, granted: 0, tiers: [] };
    const multiplied = Math.round(amount * (catchUp ? 1.5 : 1));
    const spent = ledger.day === day ? ledger.dayPoints : 0;
    const granted = Math.max(0, Math.min(multiplied, settings.season.dailyCap - spent));
    const points = ledger.points + granted;
    const reached = tierOf(points, settings);
    const tiers: number[] = [];
    for (let tier = ledger.paid + 1; tier <= reached; tier += 1) tiers.push(tier);
    return {
        ledger: { ...ledger, points, day, dayPoints: spent + granted, paid: Math.max(ledger.paid, reached) },
        granted,
        tiers
    };
}

/** What one tier gives: its levels, and a milestone's items and levels on top. */
export function tierReward(tier: number, settings: ChallengeSettings): Payout {
    const milestone = settings.season.milestones.find((one) => one.tier === tier);
    return {
        points: 0,
        levels: settings.season.levelsPerTier + (milestone?.levels ?? 0),
        items: milestone?.items ?? []
    };
}

// ------------------------------------------------------------------ the streak

/** The last milestone at or under a streak: where a broken one falls back to. */
export function milestoneFloor(count: number): number {
    let floor = 0;
    for (const milestone of catalog.STREAK_MILESTONES) if (count >= milestone) floor = milestone;
    return floor;
}

type Streak = Ledger["streak"];

/**
 * The streak after a daily is done on `today`: one more for a day right after
 * the last, the same for a second one today. Missed days in between are
 * forgiven one per week by the freeze; if any is not, the streak falls back to
 * its last milestone before counting today.
 */
export function streakAfter(streak: Streak, today: string, clock: period.Clock): { streak: Streak; milestone: number | null } {
    if (streak.lastDay === today) return { streak, milestone: null };
    let count: number;
    let freezeWeek = streak.freezeWeek;
    if (streak.lastDay === null) count = 1;
    else {
        const gap = period.dayNumber(today) - period.dayNumber(streak.lastDay) - 1;
        let kept = gap >= 0;
        for (let missed = 1; missed <= gap && kept; missed += 1) {
            const week = period.weekOfDay(clock, period.keyOfDay(period.dayNumber(streak.lastDay) + missed));
            if (freezeWeek === week) kept = false;
            else freezeWeek = week;
        }
        if (!kept) freezeWeek = streak.freezeWeek;
        count = kept ? streak.count + 1 : milestoneFloor(streak.count) + 1;
    }
    const milestone = (catalog.STREAK_MILESTONES as readonly number[]).includes(count) ? count : null;
    return {
        streak: { count, best: Math.max(streak.best, count), lastDay: today, freezeWeek },
        milestone
    };
}

/** The streak as it stands today, before anything is done today: what it will
 *  be kept at, or fall back to, if today is done. */
export function streakNow(streak: Streak, today: string, clock: period.Clock): number {
    if (streak.lastDay === null) return 0;
    if (streak.lastDay === today) return streak.count;
    const after = streakAfter(streak, today, clock).streak.count;
    return Math.max(0, after - 1);
}

/** The bonus a milestone pays. */
export function milestoneBonus(milestone: number, settings: ChallengeSettings): number {
    const index = (catalog.STREAK_MILESTONES as readonly number[]).indexOf(milestone);
    return index < 0 ? 0 : (settings.rewards.streak[index] ?? 0);
}

/** Whether somebody's first challenge now is a comeback: a week or more since the last. */
export function isComeback(ledger: Ledger, now: number): boolean {
    return ledger.lastDoneAt !== null && now - ledger.lastDoneAt >= WEEK_MS;
}
