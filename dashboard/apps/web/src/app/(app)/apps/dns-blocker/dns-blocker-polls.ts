/**
 * What the DNS blocker's insights asks again on a timer, asked through a route (see
 * `lib/poll-route`): the screen stays open across Polaris updates, and an action
 * asked on a timer failed after every one until a reload. Each answers exactly
 * what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as actions from "./actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const dnsInsights = (filter: object, fresh: boolean, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.dnsInsightsAction>>(
        "/api/dns-blocker/insights",
        { filter: JSON.stringify(filter), fresh: String(fresh) },
        signal
    );

export const dnsTail = (filter: object, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.dnsTailAction>>(
        "/api/dns-blocker/tail",
        { filter: JSON.stringify(filter) },
        signal
    );
