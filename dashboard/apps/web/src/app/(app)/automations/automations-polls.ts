/**
 * What an automation run that is still going asks again on a timer, asked through a route (see
 * `lib/poll-route`): the screen stays open across Polaris updates, and an action
 * asked on a timer failed after every one until a reload. It answers exactly
 * what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as actions from "./actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const run = (runId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.getRunAction>>("/api/automations/run", { runId }, signal);

export const hookAddress = (
    automationId: string,
    nodeId: string,
    rotation: Parameters<typeof actions.hookAddressAction>[2],
    signal?: AbortSignal
) =>
    readPoll<Answer<typeof actions.hookAddressAction>>(
        "/api/automations/hook-address",
        { automationId, nodeId, rotation: JSON.stringify(rotation) },
        signal
    );

export const chatWebhooks = (signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.chatWebhooksAction>>(
        "/api/automations/chat-webhooks",
        {},
        signal
    );

export const thresholdChoices = (signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.thresholdChoicesAction>>(
        "/api/automations/threshold-choices",
        {},
        signal
    );
