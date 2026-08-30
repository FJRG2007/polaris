/**
 * Saying what GitHub is waiting for, in the words GitHub itself uses.
 *
 * Accepting a permission request is one of the few things Polaris genuinely
 * cannot do for anybody: GitHub only lets the account owner accept, there is no
 * API for it, and no URL that accepts one on arrival. That puts it in the same
 * class as a port forward on somebody's router - not ours to do, so the screen
 * has to name it precisely instead of gesturing at it.
 *
 * What it used to say was "The GitHub App is waiting for new permissions" and a
 * link. Which permissions was nowhere on the screen, the words for them existed
 * only as API keys (`pull_requests`, `administration`) that appear nowhere in
 * GitHub's interface, and the link led to a settings page without saying which
 * of the buttons on it was the one. Somebody who did not already know the answer
 * could not get it from here.
 *
 * So: the permissions by the label GitHub prints beside the checkbox, the access
 * level in its wording rather than the API's, the button to press, and the fact
 * that nobody has to come back and tell Polaris - it re-reads what was granted
 * every few minutes and the notice goes when the grant lands.
 */

import { APP_PERMISSIONS } from "@/lib/github-service";

/**
 * What GitHub prints beside each permission on the acceptance screen.
 *
 * The API names and the interface's labels are not the same strings, and the
 * interface's are the only ones any use to somebody looking at the page: there
 * is no "pull_requests" anywhere on it. A permission with no label here is
 * printed as GitHub's own key rather than guessed at - a wrong label sends
 * somebody hunting for a row that does not exist.
 */
export const GITHUB_PERMISSION_LABELS: Readonly<Record<string, string>> = {
    actions: "Actions",
    administration: "Administration",
    checks: "Checks",
    contents: "Contents",
    deployments: "Deployments",
    issues: "Issues",
    metadata: "Metadata",
    pull_requests: "Pull requests",
    workflows: "Workflows"
};

/** GitHub's two words for an access level, from the API's one. */
function level(name: string): string {
    return APP_PERMISSIONS[name] === "write" ? "Read and write" : "Read-only";
}

/** One permission as it reads on the page somebody is being sent to. */
export function permissionLabel(name: string): string {
    return `${GITHUB_PERMISSION_LABELS[name] ?? name} (${level(name)})`;
}

/**
 * The missing permissions as a phrase, in the order GitHub lists them.
 *
 * Alphabetical by label rather than by API key, which is the order they appear
 * in on the acceptance screen, so the list here can be read straight down that
 * one.
 */
export function permissionList(missing: readonly string[]): string {
    return [...missing]
        .map(permissionLabel)
        .sort((left, right) => left.localeCompare(right))
        .join(", ");
}

/**
 * What to press, once the link has been followed.
 *
 * Two shapes, because GitHub has two: an installation with a request pending
 * shows it on the installation's own settings page, and the install flow asks
 * for the current set outright. Nothing here is a deep link to the acceptance
 * itself, because GitHub publishes none.
 */
export const ACCEPT_STEP = "Press Review request, then Accept new permissions.";

/** Said wherever the wait is reported, so nobody goes looking for a button here
 *  to tell Polaris it is done. */
export const CLEARS_ITSELF = "Polaris re-reads what GitHub granted every few minutes, so this clears on its own.";
