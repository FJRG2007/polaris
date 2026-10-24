"use client";

/**
 * The chat's /goal on screen (`lib/polar/goals.ts`): the bar over the composer
 * with its condition, where it stands and how much of its turns and time it
 * has used, with Continue for a paused goal and Clear; and the lines the
 * transcript shows for each judgement and each turn the goal sent itself.
 *
 * The goal is read from the server when a chat opens, so it survives a
 * reload, and then follows the judgements of the answers this screen watched.
 */

import { Button, cn } from "@polaris/ui";
import * as goals from "@/lib/polar/goals";
import { Play, Target, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** The open chat's goal: read when it opens, learned from watched answers. */
export function usePolarGoal(threadId: string) {
    const [goal, setGoal] = useState<goals.PolarGoal | null>(null);
    /** Goals cleared here, so a judgement still on its way cannot bring one back. */
    const cleared = useRef(new Set<string>());
    useEffect(() => {
        setGoal(null);
        const controller = new AbortController();
        fetch(`/api/polar/threads/${threadId}/goal`, { signal: controller.signal })
            .then((response) => (response.ok ? response.json() : null))
            .then((data: { goal?: unknown } | null) => {
                const found = goals.readGoal(data?.goal);
                if (found) setGoal(found);
            })
            .catch(() => undefined);
        return () => controller.abort();
    }, [threadId]);
    return {
        goal,
        isCleared: (id: string) => cleared.current.has(id),
        /** A judgement an answer carried. */
        learn: (next: goals.PolarGoal) => {
            if (!cleared.current.has(next.id)) setGoal(next);
        },
        /** Shown at once when `/goal` is sent; the first judgement replaces it. */
        begin: (condition: string) =>
            setGoal(goals.newGoal(`pending-${Date.now()}`, condition, Date.now())),
        /** Clears it, at once on screen and put back if the server refuses.
         *  The goal cleared, null when there was none, undefined on failure. */
        clear: async (): Promise<goals.PolarGoal | null | undefined> => {
            const before = goal;
            if (before) cleared.current.add(before.id);
            setGoal(null);
            const response = await fetch(`/api/polar/threads/${threadId}/goal`, {
                method: "DELETE"
            }).catch(() => null);
            const data = (await response?.json().catch(() => null)) as { goal?: unknown } | null;
            if (!response?.ok) {
                if (before) cleared.current.delete(before.id);
                setGoal(before);
                return undefined;
            }
            const gone = goals.readGoal(data?.goal);
            if (gone) cleared.current.add(gone.id);
            return gone ?? before;
        }
    };
}

/** Minutes a goal has run, rounded up so a running one never reads 0. */
function minutesOf(goal: goals.PolarGoal, now: number): number {
    const end = goal.endedAt ?? now;
    return Math.max(1, Math.ceil((end - goal.startedAt) / 60_000));
}

/** Re-renders every half minute while `on`, for a running clock. */
function useNow(on: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!on) return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 30_000);
        return () => window.clearInterval(timer);
    }, [on]);
    return now;
}

/** Where a goal stands, as the bar and `/goal` word it. */
export function goalStateKey(
    goal: goals.PolarGoal
): "active" | "idle" | "unchecked" | goals.GoalStatus {
    if (goal.status !== "active") return goal.status;
    if (goal.verdict === "idle" || goal.verdict === "unchecked") return goal.verdict;
    return "active";
}

export function PolarGoalBar({
    goal,
    busy,
    onContinue,
    onClear
}: {
    goal: goals.PolarGoal;
    busy: boolean;
    onContinue: () => void;
    onClear: () => void;
}) {
    const t = useTranslations("polar");
    const active = goal.status === "active";
    const now = useNow(active);
    const minutes = minutesOf(goal, now);
    const state = goalStateKey(goal);
    const canContinue = active && !busy && goals.goalHasRoom(goal, now);
    return (
        <div
            role="status"
            className="mb-2 flex min-w-0 items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
        >
            <Target
                aria-hidden
                className={cn(
                    "mt-0.5 size-4 shrink-0",
                    goal.status === "met"
                        ? "text-success"
                        : active
                          ? "text-primary"
                          : "text-muted-foreground"
                )}
            />
            <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-muted-foreground">
                    {t(`goal.state.${state}`)}
                </p>
                <p className="line-clamp-2 break-words" title={goal.condition}>
                    {goal.condition}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                    {t("goal.progress", {
                        turns: goal.turns,
                        max: goal.maxTurns,
                        minutes: Math.min(minutes, goals.GOAL_MINUTES_MAX),
                        limit: goals.GOAL_MINUTES_MAX,
                        tokens: goal.tokens.toLocaleString()
                    })}
                </p>
                {goal.reason ? (
                    <p
                        className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground"
                        title={goal.reason}
                    >
                        {goal.reason}
                    </p>
                ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
                {canContinue ? (
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("goal.continue")}
                        title={t("goal.continue")}
                        onClick={onContinue}
                    >
                        <Play />
                    </Button>
                ) : null}
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t(active ? "goal.clear" : "goal.dismiss")}
                    title={t(active ? "goal.clear" : "goal.dismiss")}
                    onClick={onClear}
                >
                    <X />
                </Button>
            </div>
        </div>
    );
}

/** One judgement, as the transcript shows it under its answer. */
export function PolarGoalVerdict({ goal }: { goal: goals.PolarGoal }) {
    const t = useTranslations("polar");
    if (!goal.verdict) return null;
    return (
        <p className="flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground">
            <Target aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 break-words">
                {t(`goal.verdict.${goal.verdict}`, { max: goal.maxTurns })}
                {goal.reason ? ` ${goal.reason}` : ""}
            </span>
        </p>
    );
}

/** A turn the goal sent itself, drawn as a line rather than a message. */
export function PolarGoalStep({ resumed }: { resumed: boolean }) {
    const t = useTranslations("polar");
    return (
        <p className="flex items-center justify-center gap-1.5 py-1 text-xs text-muted-foreground">
            <Target aria-hidden className="size-3.5 shrink-0" />
            {t(resumed ? "goal.resumed" : "goal.continued")}
        </p>
    );
}
