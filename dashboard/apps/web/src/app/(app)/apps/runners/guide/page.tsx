import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { RunsOnSnippet } from "../runs-on-snippet";
import { Card, CardBody, CardHeader, CardTitle, PageHeader } from "@polaris/ui";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

/**
 * What this app is and how to use it.
 *
 * Written because the rest of the app assumes an answer to a question it never
 * asks anywhere: what a self-hosted runner is, what changes in a workflow file to
 * use one, and which of the safety choices matter. Every heading here is a
 * question somebody actually has to answer to get a job running, in the order
 * they hit them.
 */
export default async function RunnersGuidePage() {
    await requirePermission("system.manage");
    const t = await getTranslations("runners");
    const strong = (chunks: React.ReactNode) => <strong key="strong">{chunks}</strong>;
    const lead = (chunks: React.ReactNode) => (
        <strong key="lead" className="text-foreground">
            {chunks}
        </strong>
    );
    const code = (chunks: React.ReactNode) => <code key="code">{chunks}</code>;
    const link = (href: string) =>
        function GuideLink(chunks: React.ReactNode) {
            return (
                <Link key={href} href={href} className="underline">
                    {chunks}
                </Link>
            );
        };

    return (
        <>
            <PageHeader
                title={t("guide.title")}
                description={t("guide.description")}
            />

            <div className="flex max-w-3xl flex-col gap-4">
                <Step title={t("guide.connect.title")}>
                    <p>{t.rich("guide.connect.body", { link: link("/admin/integrations"), strong })}</p>
                    <p>{t("guide.connect.app")}</p>
                </Step>

                <Step title={t("guide.pool.title")}>
                    <p>{t.rich("guide.pool.body", { link: link("/apps/runners") })}</p>
                    <p>{t("guide.pool.container")}</p>
                </Step>

                <Step title={t("guide.workflow.title")}>
                    <p>{t.rich("guide.workflow.body", { code })}</p>
                    <RunsOnSnippet labels={["self-hosted"]} label="" />
                    <p>{t("guide.workflow.then")}</p>
                </Step>

                <Step title={t("guide.repos.title")}>
                    <p>{t.rich("guide.repos.body", { link: link("/apps/runners/repos") })}</p>
                    <p>{t.rich("guide.repos.check", { link: link("/apps/runners/runs") })}</p>
                </Step>

                <Step title={t("guide.secrets.title")}>
                    <p>
                        {t.rich("guide.secrets.body", {
                            link: link("/apps/runners/secrets"),
                            // i18n-ignore a variable name, as a workflow step writes it
                            env: () => <code key="env">$REGISTRY_TOKEN</code>
                        })}
                    </p>
                    <p>
                        {t.rich("guide.secrets.github", {
                            // i18n-ignore GitHub's own expression syntax
                            expression: () => <code key="expression">{"${{ secrets.NAME }}"}</code>
                        })}
                    </p>
                </Step>

                <Card>
                    <CardHeader>
                        <CardTitle>{t("guide.careful.title")}</CardTitle>
                    </CardHeader>
                    <CardBody className="flex flex-col gap-3 text-sm text-muted-foreground">
                        <p>{t.rich("guide.careful.public", { lead })}</p>
                        <p>{t.rich("guide.careful.forks", { lead })}</p>
                        <p>{t.rich("guide.careful.network", { lead })}</p>
                        <p>{t.rich("guide.careful.budgets", { lead })}</p>
                    </CardBody>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>{t("guide.nothing.title")}</CardTitle>
                    </CardHeader>
                    <CardBody className="flex flex-col gap-2 text-sm text-muted-foreground">
                        <p>{t("guide.nothing.card")}</p>
                        <p>{t.rich("guide.nothing.labels", { code })}</p>
                    </CardBody>
                </Card>
            </div>
        </>
    );
}

function Step({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <Card>
            <CardHeader>
                <CardTitle>{title}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3 text-sm text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs">
                {children}
            </CardBody>
        </Card>
    );
}
