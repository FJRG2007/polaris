/**
 * What the Analytics screens read when they open, asked through routes (see
 * `lib/poll-route`): server actions from one tab run one at a time, so a read
 * on open waited behind every other one, and a press waited behind them all.
 * Each answers exactly what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as analyticsActionsModule from "@/app/(app)/apps/analytics/actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const analyticsSites = (signal?: AbortSignal) =>
    readPoll<Answer<typeof analyticsActionsModule.listAnalyticsSitesAction>>(
        "/api/analytics/sites",
        {},
        signal
    );

export const analyticsOverview = (
    input: { scopeType: string; scopeId: string; range: string },
    signal?: AbortSignal
) =>
    readPoll<Answer<typeof analyticsActionsModule.getAnalyticsOverviewAction>>(
        "/api/analytics/overview",
        input,
        signal
    );
