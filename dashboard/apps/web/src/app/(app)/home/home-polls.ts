/**
 * What the Overview asks again on a timer, asked through a route (see
 * `lib/poll-route`): the screen stays open across Polaris updates, and an action
 * asked on a timer failed after every one until a reload. Each answers exactly
 * what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as actions from "./app-widget-actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const appWidgets = (signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.readAppWidgetsAction>>("/api/home/app-widgets", {}, signal);
