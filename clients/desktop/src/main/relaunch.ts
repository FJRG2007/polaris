/**
 * The calls this app carries across a restart it makes itself
 * (`@/shared/relaunch`): held while a page is on one, written down with the
 * restart, and handed back once on the next start.
 */

import { rememberRelaunch, takeRelaunch } from "./settings";
import { heldCalls, relaunchFor, type Relaunch, type RelaunchMark } from "@/shared/relaunch";

/** Each page's call by its web contents, while it is on one. */
const held = new Map<number, { readonly origin: string; readonly note: string; }>();

/** What the last run wrote down, until every page that had a call took it. */
let carried: RelaunchMark | null = null;

/** A page is on this call now, or (null) on none. */
export function holdCall(sender: number, origin: string, note: string | null): void {
    held.delete(sender);
    if (note !== null) held.set(sender, { origin, note });
}

/** The app is about to restart itself: write down why, with the calls on. */
export function markRelaunch(reason: RelaunchMark["reason"], now = Date.now()): void {
    rememberRelaunch({ reason, at: now, calls: heldCalls(held.values()) });
}

/** The restart was called off (a push still running): what was written for
 *  it must not be taken for it on a later start. */
export function cancelRelaunch(): void {
    takeRelaunch();
}

/** At start: what the last run wrote down, read once from the file. */
export function loadRelaunch(): void {
    carried = takeRelaunch();
}

/** Why this run began, for a page of `origin`, with its call once. */
export function relaunched(origin: string, now = Date.now()): Relaunch {
    const { answer, rest } = relaunchFor(carried, origin, now);
    carried = rest;
    return answer;
}
