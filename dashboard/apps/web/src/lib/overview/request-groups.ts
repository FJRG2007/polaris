/**
 * How the Overview's figures are asked for.
 *
 * One request per group rather than one for every card, because the server
 * answers a request only once every card in it is read, and a few cards are
 * slower than the rest by a wide margin: usage and alarms come out of the
 * monitoring read, and storage reads the latest sample of every connected
 * device. Asked in the same request as the others, they held a task count and a
 * list of sessions off the screen for as long as the slowest of them took.
 *
 * Pure, so the grid and its test share it.
 */

/** The cards whose read is slow enough to be asked for on its own. */
export const SLOW_OVERVIEW_WIDGETS: ReadonlySet<string> = new Set(["usage", "alarms", "storage"]);

/** The cards asked for, split into the requests to send: the quick ones and the
 *  slow ones, each left out when empty. Order within a group is kept. */
export function overviewRequestGroups(wanted: readonly string[]): string[][] {
    const quick = wanted.filter((id) => !SLOW_OVERVIEW_WIDGETS.has(id));
    const slow = wanted.filter((id) => SLOW_OVERVIEW_WIDGETS.has(id));
    return [quick, slow].filter((group) => group.length > 0);
}
