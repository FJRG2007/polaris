/**
 * What the Code screens read when they open, asked through routes (see
 * `lib/poll-route`): server actions from one tab run one at a time, so a read
 * on open waited behind every other one, and a press waited behind them all.
 * Each answers exactly what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as codeActionsModule from "@/app/(app)/apps/code/actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const codeWork = (
    input: Parameters<typeof codeActionsModule.listWorkAction>[0],
    signal?: AbortSignal
) =>
    readPoll<Answer<typeof codeActionsModule.listWorkAction>>(
        "/api/code/work",
        { input: JSON.stringify(input) },
        signal
    );
