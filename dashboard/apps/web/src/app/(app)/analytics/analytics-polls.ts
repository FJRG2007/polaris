/**
 * What the Analytics screens read when they open, asked through routes (see
 * `lib/poll-route`): server actions from one tab run one at a time, so a read
 * on open waited behind every other one, and a press waited behind them all.
 * Each answers exactly what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as analyticsActionsModule from "@/app/(app)/analytics/actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const analyticsSites = (signal?: AbortSignal) =>
    readPoll<Answer<typeof analyticsActionsModule.listAnalyticsSitesAction>>(
        "/api/analytics/sites",
        {},
        signal
    );

export const analyticsOverview = (
    input: { scopeType: string; scopeId: string; range: string; filters: string },
    signal?: AbortSignal
) =>
    readPoll<Answer<typeof analyticsActionsModule.getAnalyticsOverviewAction>>(
        "/api/analytics/overview",
        input,
        signal
    );

export const analyticsReport = (
    input: { scopeType: string; scopeId: string; range: string; filters: string; request: string },
    signal?: AbortSignal
) =>
    readPoll<Answer<typeof analyticsActionsModule.runAnalyticsReportAction>>(
        "/api/analytics/report",
        input,
        signal
    );

export const analyticsSiteList = (input: Record<string, string>, signal?: AbortSignal) =>
    readPoll<Answer<typeof analyticsActionsModule.pageAnalyticsSitesAction>>("/api/analytics/site-list", input, signal);

export const analyticsHosted = (input: Record<string, string>, signal?: AbortSignal) =>
    readPoll<Answer<typeof analyticsActionsModule.pageHostedServicesAction>>("/api/analytics/hosted", input, signal);

export const analyticsInstallation = (input: { scopeType: string; scopeId: string }, signal?: AbortSignal) =>
    readPoll<Answer<typeof analyticsActionsModule.checkInstallationAction>>("/api/analytics/installation", input, signal);
