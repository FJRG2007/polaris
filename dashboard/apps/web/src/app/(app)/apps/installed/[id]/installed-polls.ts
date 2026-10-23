/**
 * What the installed app screens read when they open, asked through routes (see
 * `lib/poll-route`): server actions from one tab run one at a time, so a read
 * on open waited behind every other one, and a press waited behind them all.
 * Each answers exactly what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as installedActionsModule from "@/app/(app)/apps/installed/[id]/actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const redeployStrategy = (installId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof installedActionsModule.redeployStrategyAction>>(
        "/api/apps/installed/redeploy-strategy",
        { installId },
        signal
    );
