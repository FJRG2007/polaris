/**
 * What the chat screens read when they open, asked through routes (see
 * `lib/poll-route`): server actions from one tab run one at a time, so a read
 * on open waited behind every other one, and a press waited behind them all.
 * Each answers exactly what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as meetingActionsModule from "@/app/(app)/chat/meeting-actions";
import type * as actionsModule from "@/app/(app)/chat/actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const chatMembers = (channelId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actionsModule.listMembersAction>>(
        "/api/chat/members",
        { channelId },
        signal
    );

export const spaceBans = (spaceId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actionsModule.spaceBansAction>>("/api/chat/bans", { spaceId }, signal);

export const chatInvites = (spaceId: string, channelId?: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actionsModule.listInvitesAction>>(
        "/api/chat/invites",
        { spaceId, ...(channelId ? { channelId } : {}) },
        signal
    );

export const chatWebhooks = (channelId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actionsModule.listWebhooksAction>>(
        "/api/chat/webhook-list",
        { channelId },
        signal
    );

export const carriedMessage = (messageId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actionsModule.carriedMessageAction>>(
        "/api/chat/carried",
        { messageId },
        signal
    );

export const chatRules = (signal?: AbortSignal) =>
    readPoll<Answer<typeof actionsModule.chatRulesAction>>("/api/chat/rules", {}, signal);

export const callsUnavailable = (signal?: AbortSignal) =>
    readPoll<Answer<typeof meetingActionsModule.callsUnavailableAction>>(
        "/api/chat/calls-unavailable",
        {},
        signal
    );

export const editHistory = (messageId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actionsModule.editHistoryAction>>(
        "/api/chat/edit-history",
        { messageId },
        signal
    );

export const conversationsElsewhere = (signal?: AbortSignal) =>
    readPoll<Answer<typeof actionsModule.conversationsElsewhereAction>>(
        "/api/chat/elsewhere",
        {},
        signal
    );

export const tenorReady = (signal?: AbortSignal) =>
    readPoll<Answer<typeof actionsModule.tenorReadyAction>>("/api/chat/tenor-ready", {}, signal);

export const savedMedia = (signal?: AbortSignal) =>
    readPoll<Answer<typeof actionsModule.listSavedMediaAction>>(
        "/api/chat/saved-media",
        {},
        signal
    );

export const readInvite = (code: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actionsModule.readInviteAction>>("/api/chat/invite", { code }, signal);

export const inviteCandidates = (input: { spaceId: string; query: string }, signal?: AbortSignal) =>
    readPoll<Answer<typeof actionsModule.inviteCandidatesAction>>(
        "/api/chat/invite-candidates",
        input,
        signal
    );

export const messageDelivery = (messageId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actionsModule.messageDeliveryAction>>(
        "/api/chat/delivery",
        { messageId },
        signal
    );

export const linkPreview = (messageId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actionsModule.linkPreviewAction>>(
        "/api/chat/link-preview",
        { messageId },
        signal
    );

export const chatProfile = (channelId: string, userId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actionsModule.profileAction>>(
        "/api/chat/profile",
        { channelId, userId },
        signal
    );

export const meetingList = (signal?: AbortSignal) =>
    readPoll<Answer<typeof meetingActionsModule.listMeetingsAction>>(
        "/api/chat/meeting-list",
        {},
        signal
    );
