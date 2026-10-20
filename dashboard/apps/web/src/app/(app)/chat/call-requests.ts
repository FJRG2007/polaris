/**
 * The steps of getting into a call, asked through `api/chat/calls/[op]` (see
 * there for why a route and not a server action). Each answers exactly what the
 * action it replaces answers, and rejects the same way, so the callers' failure
 * handling is unchanged.
 *
 * Every step gives up after a while. A press that never hears back is a screen
 * that says "Going in" forever; one that fails says so and offers the button
 * again.
 */

import { sendAction } from "@/lib/poll-fetch";
import type * as actions from "./meeting-actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

/** Longer than a media server that is merely slow, shorter than anybody waits. */
const STEP_TIMEOUT_MS = 20_000;

function step<T>(op: string, body: Record<string, string>): Promise<T> {
    return sendAction<T>(`/api/chat/calls/${op}`, body, AbortSignal.timeout(STEP_TIMEOUT_MS));
}

export const startCall = (channelId: string) =>
    step<Answer<typeof actions.startCallAction>>("start", { channelId });

export const joinCall = (meetingId: string) =>
    step<Answer<typeof actions.joinCallAction>>("join", { meetingId });

export const joinMeeting = (meetingId: string) =>
    step<Answer<typeof actions.joinMeetingAction>>("join-meeting", { meetingId });

export const callTicket = (meetingId: string) =>
    step<Answer<typeof actions.callTokenAction>>("ticket", { meetingId });

export const readCall = (meetingId: string) =>
    step<Answer<typeof actions.readCallAction>>("read", { meetingId });

export const ownVoice = (meetingId: string) =>
    step<Answer<typeof actions.ownVoiceAction>>("own-voice", { meetingId });

export const licensedFilter = (meetingId: string) =>
    step<Answer<typeof actions.licensedFilterAction>>("licensed-filter", { meetingId });

export const claimCall = (meetingId: string, deviceId: string) =>
    step<Answer<typeof actions.claimCallAction>>("claim", { meetingId, deviceId });
