import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { providersFor } from "@/lib/agents/model-keys";
import { getGithubStatus, githubPermissionGap } from "@/lib/github-service";
import { ACCEPT_STEP, CLEARS_ITSELF, permissionList } from "@/lib/integrations/github-permission-copy";

/**
 * The one thing standing between here and a working agent, when there is one.
 *
 * Ordered by what has to be true first, and only ever showing the earliest
 * missing piece: a list of four things nobody has done yet reads as a chore,
 * while one sentence with one link reads as the next step.
 */
export async function SetupNotice() {
    const user = await requirePermission("agents.read");
    const [github, gap, providers] = await Promise.all([
        getGithubStatus().catch(() => null),
        githubPermissionGap().catch(() => ({
            installations: [],
            reviewUrl: null,
            appMissing: [],
            appPermissionsUrl: null
        })),
        providersFor(user.id).catch(() => [])
    ]);

    if (github?.method !== "app") {
        return (
            <Notice>
                Agents need a GitHub App, which an administrator creates in one click under{" "}
                <Link href="/admin/integrations" className="underline">
                    Integrations
                </Link>
                . A personal access token is not enough: the agent has to comment and open pull requests as itself.
            </Notice>
        );
    }

    // An App that gained permissions does not gain them on anything it is already
    // installed on until the owner accepts. Every dispatch fails with an opaque
    // 403 until then.
    //
    // Addressed to an administrator, and only to one. Accepting is done in
    // GitHub's own settings by whoever owns the installation, which in a Polaris
    // deployment is the person who connected it - so to everybody else this was a
    // wall of instructions for a page they cannot open, about an App they did not
    // install, on an account that is not theirs. They still get told their runs
    // are refused, because a run failing for no stated reason is worse; they just
    // do not get handed a chore they cannot do.
    // The step before the acceptance, and the one nobody was being told about.
    //
    // GitHub is sent the permission set once, in the manifest that creates the
    // App, and publishes no way to change it afterwards. So an App created before
    // a permission was added to `APP_PERMISSIONS` does not ask for it, no
    // installation is holding a request for it, and the acceptance screen below
    // has nothing on it. This screen nevertheless said "so-and-so has not granted
    // Deployments" and sent people to press a button that was not there - every
    // few minutes, forever, with no way to make it stop.
    //
    // Naming the real first step is the fix. It is genuinely the owner's to do
    // and genuinely by hand, which puts it in the same class as a DNS record at
    // a registrar: not ours, so say it precisely, with the address and the exact
    // rows to set.
    if (gap.appMissing.length > 0) {
        if (!user.isAdmin) {
            return (
                <Notice>
                    Runs are paused: the GitHub App is missing a permission that only an administrator can add.
                    Nothing to do here - it starts working again on its own once they have.
                </Notice>
            );
        }
        return (
            <Notice>
                <p>
                    The GitHub App does not ask for {permissionList(gap.appMissing)} yet, so nobody can grant it -
                    there is no request for anyone to accept. GitHub only lets the App&apos;s owner change what it
                    asks for, and only by hand.
                </p>
                {gap.appPermissionsUrl ? (
                    <p className="mt-2">
                        Set {permissionList(gap.appMissing)} on{" "}
                        <a
                            href={gap.appPermissionsUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="break-all underline"
                        >
                            {gap.appPermissionsUrl}
                        </a>{" "}
                        and save. Each account it is installed on then gets a request to accept, which this screen
                        will ask you for next.
                    </p>
                ) : null}
                <p className="mt-2 opacity-80">{CLEARS_ITSELF}</p>
            </Notice>
        );
    }

    if (gap.installations.length > 0) {
        if (!user.isAdmin) {
            return (
                <Notice>
                    Runs are paused: GitHub is waiting for an administrator to accept a permission request. Nothing to
                    do here - it starts working again on its own once they have.
                </Notice>
            );
        }
        return (
            <Notice>
                <p>
                    GitHub is holding a permission request, and until its owner accepts it, runs on these accounts are
                    refused. Only they can accept it - GitHub offers nobody else a way, so this is one of the few
                    things Polaris cannot do for you.
                </p>
                <ul className="mt-2 flex flex-col gap-1.5">
                    {gap.installations.map((row) => (
                        <li key={row.login}>
                            <span className="font-medium">{row.login}</span> has not granted{" "}
                            {permissionList(row.missing)}.{" "}
                            {row.reviewUrl ? (
                                <>
                                    {ACCEPT_STEP} On{" "}
                                    {/* The address, written out rather than hidden
                                        behind a word. It is the page an acceptance
                                        actually happens on, it is per-installation
                                        and unguessable, and somebody signed in to
                                        GitHub as another account has to be able to
                                        take it to the browser that is. */}
                                    <a
                                        href={row.reviewUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="break-all underline"
                                    >
                                        {row.reviewUrl}
                                    </a>
                                </>
                            ) : (
                                // Only for a deployment holding neither the App's
                                // page nor its name, which is a deployment with no
                                // App. Naming the page beats a link that 404s.
                                <span>Open it under Settings, Applications, on GitHub, then {lowerFirst(ACCEPT_STEP)}</span>
                            )}
                        </li>
                    ))}
                </ul>
                <p className="mt-2 opacity-80">{CLEARS_ITSELF}</p>
            </Notice>
        );
    }

    if (providers.length === 0) {
        return (
            <Notice>
                No model provider is connected, so a run has nothing to think with. Add one under{" "}
                <Link href="/account/ai-keys" className="underline">
                    AI provider keys
                </Link>
                . The key stays here and is never copied into your repositories.
            </Notice>
        );
    }

    return null;
}

function Notice({ children }: { children: React.ReactNode }) {
    return (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-200/90">
            {children}
        </div>
    );
}

/** A sentence pasted mid-sentence. */
function lowerFirst(value: string): string {
    return value.charAt(0).toLowerCase() + value.slice(1);
}
