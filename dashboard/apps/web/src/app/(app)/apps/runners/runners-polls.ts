/**
 * What the Runners screens read when they open, asked through routes (see
 * `lib/poll-route`): server actions from one tab run one at a time, so a read
 * on open waited behind every other one, and a press waited behind them all.
 * Each answers exactly what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as runnersActionsModule from "@/app/(app)/apps/runners/actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const runnerHost = (serverId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof runnersActionsModule.probeRunnerHostAction>>(
        "/api/runners/probe",
        { serverId },
        signal
    );

export const runnerPrincipals = (signal?: AbortSignal) =>
    readPoll<Answer<typeof runnersActionsModule.runnerPrincipalsAction>>(
        "/api/runners/principals",
        {},
        signal
    );

export const scopePreview = (
    input: Parameters<typeof runnersActionsModule.previewScopeAction>[0],
    signal?: AbortSignal
) =>
    readPoll<Answer<typeof runnersActionsModule.previewScopeAction>>(
        "/api/runners/scope-preview",
        { input: JSON.stringify(input) },
        signal
    );
