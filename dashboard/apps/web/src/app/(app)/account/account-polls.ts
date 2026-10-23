/**
 * What the account screens read when they open, asked through routes (see
 * `lib/poll-route`): server actions from one tab run one at a time, so a read
 * on open waited behind every other one, and a press waited behind them all.
 * Each answers exactly what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as stepUpActionsModule from "@/app/(app)/account/step-up-actions";
import type * as sessionsActionsModule from "@/app/(app)/account/sessions/actions";
import type * as privacyActionsModule from "@/app/(app)/account/privacy/actions";
import type * as usageActionsModule from "@/app/(app)/account/api-keys/usage-actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const keyUsage = (input: { keyId: string; range: string }, signal?: AbortSignal) =>
    readPoll<Answer<typeof usageActionsModule.keyUsageAction>>(
        "/api/account/api-keys/usage",
        input,
        signal
    );

export const friendsPage = (
    after: Parameters<typeof privacyActionsModule.loadFriendsAction>[0],
    signal?: AbortSignal
) =>
    readPoll<Answer<typeof privacyActionsModule.loadFriendsAction>>(
        "/api/account/friends",
        { after: JSON.stringify(after) },
        signal
    );

export const friendRequests = (signal?: AbortSignal) =>
    readPoll<Answer<typeof privacyActionsModule.loadFriendRequestsAction>>(
        "/api/account/friends/requests",
        {},
        signal
    );

export const stepUpRemaining = (purpose: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof stepUpActionsModule.stepUpRemainingAction>>(
        "/api/account/step-up/remaining",
        { purpose },
        signal
    );

export const trustedDevice = (deviceId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof sessionsActionsModule.trustedDeviceAction>>(
        "/api/account/sessions/device",
        { deviceId },
        signal
    );
