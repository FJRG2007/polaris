import Link from "next/link";
import { Check } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { getGithubStatus } from "@/lib/github-service";
import { providersFor } from "@/lib/agents/model-keys";
import { listAgentRepos } from "@/lib/agents/agent-repo-service";
import { Button, Card, CardBody, PageHeader } from "@polaris/ui";

export const dynamic = "force-dynamic";

/**
 * Getting from nothing to a working agent.
 *
 * Three steps, each showing whether it is already done, so somebody returning
 * halfway through sees where they are rather than starting again. The first two
 * are administrator work in Integrations and the third is here, which is exactly
 * why they are listed together: they are done by different people on different
 * screens and nobody would guess the order.
 */
export default async function AgentSetupPage() {
    const user = await requirePermission("agents.read");
    const [github, providers, repos] = await Promise.all([
        getGithubStatus().catch(() => null),
        providersFor(user.id).catch(() => []),
        listAgentRepos(user.id)
    ]);

    const appReady = github?.method === "app";
    const modelReady = providers.length > 0;
    const repoReady = repos.length > 0;

    return (
        <>
            <PageHeader
                title="Set up"
                description="Three things have to be true before an agent can run. This is where they are."
            />
            <div className="space-y-3">
                <Step
                    done={appReady}
                    title="Connect a GitHub App"
                    body="An App lets the agent comment, review and open pull requests as itself, and lets Polaris hear about issues and pull requests. A personal access token cannot do either. An administrator creates one in a click."
                    href="/admin/integrations"
                    action="Open Integrations"
                />
                <Step
                    done={modelReady}
                    title="Connect a model provider"
                    body="Your own key with Anthropic, OpenAI, Google, xAI, DeepSeek, Moonshot, Groq, Cerebras or OpenRouter, or an OpenAI-compatible gateway. Polaris hands it to a run over an authenticated call and never writes a copy into your repositories, so rotating it takes effect everywhere."
                    href="/account/ai-keys"
                    action="Add a provider key"
                />
                <Step
                    done={repoReady}
                    title="Add a repository"
                    body="Pick where its runs should happen. Polaris recommends the cheapest option that fits: hosted runners for a public repository, your own hardware for a private one."
                    href="/apps/agents/repos"
                    action="Add a repository"
                />
            </div>

            {appReady && modelReady && repoReady ? (
                <Card className="mt-4">
                    <CardBody className="space-y-2 py-6">
                        <p className="text-sm">
                            Everything is in place. Open an issue in one of your repositories and mention{" "}
                            <code className="rounded bg-white/5 px-1">@{github?.login ?? "the app"}</code> to try it.
                        </p>
                        <p className="text-sm text-muted-foreground">
                            To have it act without being asked, add a rule under Automations.
                        </p>
                    </CardBody>
                </Card>
            ) : null}
        </>
    );
}

function Step({
    done,
    title,
    body,
    href,
    action
}: {
    done: boolean;
    title: string;
    body: string;
    href: string;
    action: string;
}) {
    return (
        <Card>
            <CardBody className="flex items-start gap-4 py-5">
                <span
                    aria-hidden
                    className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border ${
                        done ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400" : "border-white/15"
                    }`}
                >
                    {done ? <Check className="size-3.5 shrink-0" /> : null}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-sm font-medium">{title}</p>
                    <p className="text-sm text-muted-foreground">{body}</p>
                </div>
                {done ? null : (
                    <Button asChild size="sm" variant="secondary">
                        <Link href={href}>{action}</Link>
                    </Button>
                )}
            </CardBody>
        </Card>
    );
}
