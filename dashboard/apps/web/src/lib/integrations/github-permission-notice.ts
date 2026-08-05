/**
 * Telling somebody the GitHub App is waiting on a permission.
 *
 * Widening `APP_PERMISSIONS` does not widen an App that already exists: GitHub
 * holds the new request until the account owner accepts it, and until they do,
 * everything that needed it fails with a 403 an hour into setting something up.
 * The Integrations and Agents screens already say so, but only to whoever
 * happens to open them - the person who has to act may never look, and the
 * feature they broke is one they think they configured.
 *
 * So it is a notification, sent to the people who can actually do something
 * about it. Once per gap: the set of missing permissions is the identity, so a
 * gap that is still open tomorrow does not produce a second notification, and a
 * gap that widens does.
 */

import { getSetting, setSetting } from "@/lib/setting-store";
import { notifyOperators } from "@/lib/notifications/operators";
import { githubPermissionGap, refreshInstallations } from "@/lib/github-service";

/** What was last announced, so the same gap is not announced twice. */
const SEEN_KEY = "integrations.github.permission-gap";

/** Stable identity for a gap: which installations are missing what. Sorted, so
 *  the order GitHub happens to report them in cannot look like a change. */
function fingerprint(gap: Array<{ login: string; missing: readonly string[] }>): string {
    return gap
        .map((row) => `${row.login}:${[...row.missing].sort().join(",")}`)
        .sort()
        .join("|");
}

/**
 * Announce the current gap, if there is one nobody has been told about.
 *
 * Best-effort and safe to call often: it reads one setting on the common path
 * (no gap, nothing announced) and writes nothing.
 */
export async function notifyGithubPermissionGap(): Promise<void> {
    try {
        // What GitHub granted is read from a stored copy, and that copy was only
        // ever refreshed by a button on the Integrations screen. So somebody who
        // went and accepted the request stayed warned about it until they
        // happened to open that screen and press it - told to do a thing they had
        // already done. Re-read first; it is one call every few minutes.
        await refreshInstallations().catch(() => undefined);

        const gap = await githubPermissionGap();
        const current = fingerprint(gap.installations);
        const seen = await getSetting(SEEN_KEY);
        if (current === (seen ?? "")) return;

        // The gap closed. Forget it, so the next one is announced again.
        if (current === "") {
            await setSetting(SEEN_KEY, null);
            return;
        }

        // Only people who could act on it. Somebody without the permission to
        // manage integrations cannot accept anything on GitHub's side either, and
        // an alert they can only read is noise.
        const names = gap.installations.map((row) => row.login).join(", ");
        const missing = [...new Set(gap.installations.flatMap((row) => row.missing))].sort().join(", ");

        await notifyOperators({
            permission: "system.manage",
            event: "integrations.github.permissions",
            title: "The GitHub App is waiting for permissions",
            body: `${names} has not accepted: ${missing}. Until it does, anything that needs them is refused - runner pools, and any repository the App was just granted more access to.`,
            href: gap.reviewUrl ?? "/integrations",
            level: "warning",
            actionRequired: true
        });
        await setSetting(SEEN_KEY, current);
    } catch {
        // Never the reason something else fails: this is an announcement about a
        // problem, not the handling of one.
    }
}
