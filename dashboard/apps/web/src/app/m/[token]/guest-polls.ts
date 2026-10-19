/**
 * What a guest waiting at a call's door asks again on a timer, asked through a route (see
 * `lib/poll-route`): the screen stays open across Polaris updates, and an action
 * asked on a timer failed after every one until a reload. It answers exactly
 * what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as actions from "@/app/(app)/chat/meeting-actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const guestCall = (meetingId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.readCallAction>>("/api/guest-call", { meetingId }, signal);
