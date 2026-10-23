/**
 * What the Tasks screens read when they open, asked through routes (see
 * `lib/poll-route`): server actions from one tab run one at a time, so a read
 * on open waited behind every other one, and a press waited behind them all.
 * Each answers exactly what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as trackersActionsModule from "@/app/(app)/tasks/trackers/actions";
import type * as tasksActionsModule from "@/app/(app)/tasks/actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const handoffChoices = (signal?: AbortSignal) =>
    readPoll<Answer<typeof tasksActionsModule.agentHandoffChoicesAction>>(
        "/api/tasks/agent-handoff",
        {},
        signal
    );

export const taskDetail = (taskId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof tasksActionsModule.getTaskDetailAction>>(
        "/api/tasks/detail",
        { taskId },
        signal
    );

export const taskShare = (taskId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof tasksActionsModule.getTaskShareAction>>(
        "/api/tasks/share",
        { taskId },
        signal
    );

export const createContext = (spaceId: string, folderId?: string | null, signal?: AbortSignal) =>
    readPoll<Answer<typeof tasksActionsModule.createContextAction>>(
        "/api/tasks/create-context",
        { spaceId, ...(folderId ? { folderId } : {}) },
        signal
    );

export const trackerTargets = (signal?: AbortSignal) =>
    readPoll<Answer<typeof trackersActionsModule.trackerTargetsAction>>(
        "/api/tasks/trackers/targets",
        {},
        signal
    );
