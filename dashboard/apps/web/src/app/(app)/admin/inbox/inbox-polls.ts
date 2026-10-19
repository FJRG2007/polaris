/**
 * What the admin Inbox asks again on a timer, asked through routes (see
 * `lib/poll-route`): the Inbox stays open across Polaris updates, and an action
 * asked on a timer failed after every one until a reload. Each answers exactly
 * what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as actions from "./actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const conversations = (signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.listConversationsAction>>(
        "/api/inbox/conversations",
        {},
        signal
    );

export const messages = (conversationId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.getMessagesAction>>(
        "/api/inbox/messages",
        { conversationId },
        signal
    );

export const activity = (signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.listActivityAction>>("/api/inbox/activity", {}, signal);

export const channelState = (channelId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.channelStateAction>>(
        "/api/inbox/channel-state",
        { channelId },
        signal
    );
