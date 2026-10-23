/**
 * What the Firewall screens read when they open, asked through routes (see
 * `lib/poll-route`): server actions from one tab run one at a time, so a read
 * on open waited behind every other one, and a press waited behind them all.
 * Each answers exactly what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as firewallActionsModule from "@/app/(app)/apps/firewall/actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const addressActivity = (ip: string, hours: number, signal?: AbortSignal) =>
    readPoll<Answer<typeof firewallActionsModule.getWafAddressActivityAction>>(
        "/api/firewall/address-activity",
        { ip, hours: String(hours) },
        signal
    );

export const wafRule = (
    input: {
        scopeType: Parameters<typeof firewallActionsModule.getWafRuleAction>[0]["scopeType"];
        scopeId: string;
    },
    signal?: AbortSignal
) =>
    readPoll<Answer<typeof firewallActionsModule.getWafRuleAction>>(
        "/api/firewall/rule",
        input,
        signal
    );
