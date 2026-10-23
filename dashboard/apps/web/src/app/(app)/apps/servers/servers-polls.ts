/**
 * What a server's page asks again on a timer, asked through a route (see
 * `lib/poll-route`): the screen stays open across Polaris updates, and an action
 * asked on a timer failed after every one until a reload. Each answers exactly
 * what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as sshKeyActionsModule from "@/app/(app)/apps/servers/ssh-key-actions";
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

export const removalPlan = (hostId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.serverRemovalPlanAction>>(
        "/api/servers/removal-plan",
        { hostId },
        signal
    );

export const hostGroups = (signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.listHostGroupsAction>>("/api/servers/groups", {}, signal);

export const followState = (hostId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.serverFollowStateAction>>(
        "/api/servers/follow-state",
        { hostId },
        signal
    );

export const githubKeys = (signal?: AbortSignal) =>
    readPoll<Answer<typeof sshKeyActionsModule.githubKeysAction>>(
        "/api/servers/github-keys",
        {},
        signal
    );

export const leftoverAutoRemove = (signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.leftoverAutoRemoveAction>>(
        "/api/servers/leftover-auto-remove",
        {},
        signal
    );

export const sharedHost = (hostId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.sharedHostAction>>(
        "/api/servers/shared-host",
        { hostId },
        signal
    );
