/**
 * What an account recovery request waiting for its decision asks again on a timer, asked through a route (see
 * `lib/poll-route`): the screen stays open across Polaris updates, and an action
 * asked on a timer failed after every one until a reload. It answers exactly
 * what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as actions from "./actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const recoveryStatus = (ticket: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.recoveryStatusAction>>(
        "/api/account-recovery/status",
        { ticket },
        signal
    );
