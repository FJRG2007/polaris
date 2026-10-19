/**
 * What a server's page asks again on a timer, asked through a route (see
 * `lib/poll-route`): the screen stays open across Polaris updates, and an action
 * asked on a timer failed after every one until a reload. Each answers exactly
 * what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as actions from "./actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const serverEdge = (hostId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.serverEdgeAction>>("/api/servers/edge", { hostId }, signal);

export const enrollmentStatus = (id: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.enrollmentStatusAction>>(
        "/api/servers/enrollment-status",
        { id },
        signal
    );
