import Link from "next/link";
import { connectedProviders } from "@/lib/agents/agent-providers";
import { getGithubStatus, githubPermissionGap } from "@/lib/github-service";

/**
 * The one thing standing between here and a working agent, when there is one.
 *
 * Ordered by what has to be true first, and only ever showing the earliest
 * missing piece: a list of four things nobody has done yet reads as a chore,
 * while one sentence with one link reads as the next step.
 */
export async function SetupNotice() {
    const [github, gap, providers] = await Promise.all([
        getGithubStatus().catch(() => null),
        githubPermissionGap().catch(() => ({ installations: [], reviewUrl: null })),
        connectedProviders().catch(() => [])
    ]);

    if (github?.method !== "app") {
        return (
            <Notice>
                Agents need a GitHub App, which an administrator creates in one click under{" "}
                <Link href="/integrations" className="underline">
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
        const names = gap.installations.map((row) => row.login).join(", ");
        return (
            <Notice>
                The GitHub App is waiting for new permissions on {names}. Until they are accepted, runs there will be
                refused.{" "}
                {gap.reviewUrl ? (
                    <a href={gap.reviewUrl} target="_blank" rel="noreferrer" className="underline">
                        Review them on GitHub
                    </a>
                ) : (
                    <Link href="/integrations" className="underline">
                        Open Integrations
                    </Link>
                )}
            </Notice>
        );
    }

    if (providers.length === 0) {
        return (
            <Notice>
                No model provider is connected, so a run has nothing to think with. Add one under{" "}
                <Link href="/integrations" className="underline">
                    Integrations
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
