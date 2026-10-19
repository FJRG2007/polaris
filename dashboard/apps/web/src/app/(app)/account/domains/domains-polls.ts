/**
 * What a domain of one's own, while its certificate or a DNS record settles, asks again on a timer, asked through a route (see
 * `lib/poll-route`): the screen stays open across Polaris updates, and an action
 * asked on a timer failed after every one until a reload. It answers exactly
 * what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as actions from "./actions";
import type * as dns from "./dns-actions";
import type { DomainOwnerRef } from "@/lib/owner-domain-caller";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const ownerDomain = (owner: DomainOwnerRef, id: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.readOwnerDomainAction>>(
        "/api/domains/owner-domain",
        { owner: JSON.stringify(owner), id },
        signal
    );

export const dnsPropagation = (scope: dns.DnsScopeRef, recordId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof dns.dnsPropagationAction>>(
        "/api/domains/dns-propagation",
        { scope: JSON.stringify(scope), recordId },
        signal
    );
