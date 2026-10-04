/**
 * What the command-line client may ask to be allowed to do.
 *
 * A closed list rather than every permission: the CLI's commands reach the
 * Deploy API and nothing else, so a sign-in that asked for mail or the vault
 * would be a credential broader than anything it can use. Growing a command set
 * means growing this list, which is what puts the new reach on the approval
 * screen where the person saying yes can see it.
 *
 * Client-safe: the approval screen imports it.
 */

export const CLI_SCOPES = ["deploy.read", "deploy.manage"] as const;

export type CliScope = (typeof CLI_SCOPES)[number];

/** Whether a string is one of the scopes the CLI may ask for. */
export function isCliScope(value: string): value is CliScope {
    return (CLI_SCOPES as readonly string[]).includes(value);
}

/** How long a CLI sign-in lasts before `plr login` has to be run again. A year:
 *  long enough to sign in once per machine, short enough that a laptop nobody
 *  uses any more stops holding a working credential on its own. */
export const CLI_TOKEN_DAYS = 365;

/** Where somebody answers a CLI's request, with its code already filled in. */
export function cliApprovePath(userCode: string): string {
    return `/account/cli?code=${encodeURIComponent(userCode)}`;
}
