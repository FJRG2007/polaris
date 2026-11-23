/**
 * What Polaris Terminal may ask to be allowed to do.
 *
 * A closed list, like the CLI's and the deck's: the terminal's own assistant
 * talks to Polar through the compatible endpoints (`/api/v1/chat/completions`,
 * `/api/v1/messages`, `/api/v1/responses`, `/api/v1/models`), and that is all
 * its key reaches today. `polar.spend` is what lets those calls run on the
 * deployment's provider keys rather than the person's own; like every scope it
 * is narrowed again to what the approving account holds, so somebody without it
 * still connects and talks to Polar on their own keys. `terminal.control` lets
 * the terminal hold its socket on the remote-control relay, so the account's
 * other devices can reach it (`terminal-relay.mjs`). Growing what the terminal
 * does means growing this list, which puts the new reach on the approval
 * screen.
 *
 * Client-safe: the approval screen imports it.
 */

export const TERMINAL_SCOPES = ["polar.use", "polar.spend", "terminal.control"] as const;

export type TerminalScope = (typeof TERMINAL_SCOPES)[number];

/** Whether a string is one of the scopes the terminal may ask for. */
export function isTerminalScope(value: string): value is TerminalScope {
    return (TERMINAL_SCOPES as readonly string[]).includes(value);
}

/** How long a terminal stays signed in before it has to sign in again. A year,
 *  for the reason the CLI's sign-in lasts one. */
export const TERMINAL_TOKEN_DAYS = 365;

/** Where somebody answers a terminal's request, with its code already filled in. */
export function terminalApprovePath(userCode: string): string {
    return `/account/terminal?code=${encodeURIComponent(userCode)}`;
}
