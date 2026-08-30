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
        githubPermissionGap().catch(() => ({ installations: [], reviewUrl: null })),
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
    // 403 until then, so this is worth saying before anybody enables a repository.
    if (gap.installations.length > 0) {
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
                                <a href={row.reviewUrl} target="_blank" rel="noreferrer" className="underline">
                                    Open its installation on GitHub
                                </a>
                            ) : (
                                // No link only where the account type was never
                                // recorded, so neither of GitHub's two paths is
                                // known to apply. Naming the page is still better
                                // than a link that 404s.
                                <span>Open it under Settings, Applications, on GitHub</span>
                            )}
                            , then {ACCEPT_STEP.charAt(0).toLowerCase() + ACCEPT_STEP.slice(1)}
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
