/**
 * What the Telemetry screens read when they open, asked through routes (see
 * `lib/poll-route`): server actions from one tab run one at a time, so a read
 * on open waited behind every other one, and a press waited behind them all.
 * Each answers exactly what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as telemetryActionsModule from "@/app/(app)/telemetry/actions";

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

/** The routes that answer one parsed input, each the action of the same name. */
function inputPoll<F extends (input: unknown) => Promise<unknown>>(path: string) {
    return (input: Parameters<F>[0], signal?: AbortSignal) =>
        readPoll<Answer<F>>(path, { input: JSON.stringify(input) }, signal);
}

export const telemetryIssues = inputPoll<typeof telemetryActionsModule.searchIssuesAction>(
    "/api/telemetry/issues"
);
export const telemetryEvents = inputPoll<typeof telemetryActionsModule.eventsPageAction>(
    "/api/telemetry/events"
);
export const telemetryEvent = inputPoll<typeof telemetryActionsModule.openEventAction>(
    "/api/telemetry/event"
);
export const telemetryProjects = inputPoll<typeof telemetryActionsModule.projectsPageAction>(
    "/api/telemetry/projects"
);
export const telemetryActivity = inputPoll<typeof telemetryActionsModule.issueActivityAction>(
    "/api/telemetry/activity"
);
export const telemetryAlertRules = inputPoll<typeof telemetryActionsModule.alertRulesAction>(
    "/api/telemetry/alert-rules"
);
export const telemetryAlertHistory = inputPoll<typeof telemetryActionsModule.alertHistoryAction>(
    "/api/telemetry/alert-history"
);
export const telemetryReleases = inputPoll<typeof telemetryActionsModule.releasesAction>(
    "/api/telemetry/releases"
);
export const telemetryEnvironments = inputPoll<typeof telemetryActionsModule.environmentsAction>(
    "/api/telemetry/environments"
);
export const telemetryPerformance = inputPoll<typeof telemetryActionsModule.performancePageAction>(
    "/api/telemetry/performance"
);
export const telemetryRoute = inputPoll<typeof telemetryActionsModule.routeDetailAction>(
    "/api/telemetry/performance-route"
);
