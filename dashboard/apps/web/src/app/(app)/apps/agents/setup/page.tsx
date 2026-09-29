import Link from "next/link";
import { Check } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { getGithubStatus } from "@/lib/github-service";
import { providersFor } from "@/lib/agents/model-keys";
import { listAgentRepos } from "@/lib/agents/agent-repo-service";
import { Button, Card, CardBody, PageHeader } from "@polaris/ui";
import { getTranslations } from "@/lib/i18n/request";

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

    const t = await getTranslations("agents");
    const appReady = github?.method === "app";
    const modelReady = providers.length > 0;
    const repoReady = repos.length > 0;

    return (
        <>
            <PageHeader
                title={t("overview.setUp")}
                description={t("setup.description")}
            />
            <div className="space-y-3">
                <Step
                    done={appReady}
                    title={t("setup.app.title")}
                    body={t("setup.app.body")}
                    href="/admin/integrations"
                    action={t("setup.app.action")}
                />
                <Step
                    done={modelReady}
                    title={t("setup.model.title")}
                    body={t("setup.model.body")}
                    href="/account/ai-keys"
                    action={t("setup.model.action")}
                />
                <Step
                    done={repoReady}
                    title={t("repos.add")}
                    body={t("setup.repo.body")}
                    href="/apps/agents/repos"
                    action={t("repos.add")}
                />
            </div>

            {appReady && modelReady && repoReady ? (
                <Card className="mt-4">
                    <CardBody className="space-y-2 py-6">
                        <p className="text-sm">
                            {t.rich("setup.ready", {
                                app: `@${github?.login ?? t("setup.theApp")}`,
                                code: (chunks) => (
                                    <code key="app" className="rounded bg-white/5 px-1">
                                        {chunks}
                                    </code>
                                )
                            })}
                        </p>
                        <p className="text-sm text-muted-foreground">{t("setup.readyHint")}</p>
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
                        done ? "border-success-edge bg-success-soft text-success-ink" : "border-white/15"
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
