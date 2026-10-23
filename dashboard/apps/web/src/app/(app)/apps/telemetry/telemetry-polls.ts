/**
 * What the Telemetry screens read when they open, asked through routes (see
 * `lib/poll-route`): server actions from one tab run one at a time, so a read
 * on open waited behind every other one, and a press waited behind them all.
 * Each answers exactly what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as telemetryActionsModule from "@/app/(app)/apps/telemetry/actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const telemetryOverview = (
    input: Parameters<typeof telemetryActionsModule.telemetryOverviewAction>[0],
    signal?: AbortSignal
) =>
    readPoll<Answer<typeof telemetryActionsModule.telemetryOverviewAction>>(
        "/api/telemetry/overview",
        { input: JSON.stringify(input) },
        signal
    );

export const telemetryIssue = (projectId: string, issueId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof telemetryActionsModule.openIssueAction>>(
        "/api/telemetry/issue",
        { projectId, issueId },
        signal
    );
