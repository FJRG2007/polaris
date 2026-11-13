/**
 * What the channel screens ask again on a timer, asked through routes (see
 * `lib/poll-route`): a screen stays open across Polaris updates, and an action
 * asked on a timer failed after every one until a reload. Each answers exactly
 * what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as actions from "./actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const channelState = (channelId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.channelStateAction>>(
        "/api/admin/channels/state",
        { channelId },
        signal
    );
