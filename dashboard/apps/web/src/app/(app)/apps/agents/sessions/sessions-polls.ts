/**
 * What a starting agent session asks again on a timer, asked through a route (see
 * `lib/poll-route`): the screen stays open across Polaris updates, and an action
 * asked on a timer failed after every one until a reload. Each answers exactly
 * what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as actions from "./actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const sessionScreen = (sessionId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.sessionScreenAction>>(
        "/api/agents/sessions/screen",
        { sessionId },
        signal
    );

export const sessionChoices = (signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.sessionChoicesAction>>(
        "/api/agents/sessions/choices",
        {},
        signal
    );

export const sessionChanges = (
    input: Parameters<typeof actions.sessionChangesAction>[0],
    signal?: AbortSignal
) =>
    readPoll<Answer<typeof actions.sessionChangesAction>>(
        "/api/agents/sessions/changes",
        { input: JSON.stringify(input) },
        signal
    );
