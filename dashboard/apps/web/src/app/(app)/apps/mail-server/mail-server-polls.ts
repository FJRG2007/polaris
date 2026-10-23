/**
 * What a mail server's overview asks again on a timer, asked through a route (see
 * `lib/poll-route`): the screen stays open across Polaris updates, and an action
 * asked on a timer failed after every one until a reload. It answers exactly
 * what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as actions from "./actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const serverDetail = (serverId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.serverDetailAction>>(
        "/api/mail-server/detail",
        { serverId },
        signal
    );

export const dnsPlan = (input: Parameters<typeof actions.planDnsAction>[0], signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.planDnsAction>>(
        "/api/mail-server/dns-plan",
        { input: JSON.stringify(input) },
        signal
    );

export const placements = (signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.listPlacementsAction>>(
        "/api/mail-server/placements",
        {},
        signal
    );
