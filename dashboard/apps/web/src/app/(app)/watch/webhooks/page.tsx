import Link from "next/link";
import { prisma } from "@polaris/db";
import { PageHeader } from "@polaris/ui";
import { WatchWebhooks } from "./watch-webhooks";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { visibleProjectIds } from "@/lib/deploy-project-access";

export const dynamic = "force-dynamic";

/**
 * Every endpoint alerts leave through, in one place - which is the question
 * Watch exists to answer for the whole instance, rather than one project at a
 * time. The panel itself is shared with each project's own settings screen, so
 * an endpoint is the same endpoint wherever it is reached from.
 */
export default async function WatchWebhooksPage() {
    const user = await requirePermission("deploy.read");
    const ids = await visibleProjectIds(user.id);
    const t = await getTranslations("watch");
    const projects = await prisma.project.findMany({
        where: { id: { in: ids } },
        orderBy: { name: "asc" },
        select: { id: true, name: true, _count: { select: { webhooks: true } } }
    });

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
            <PageHeader
                title={t("webhooks.title")}
                description={t("webhooks.description")}
            />

            {projects.length === 0 ? (
                <div className="rounded-lg border border-border/60 px-4 py-10 text-center">
                    <p className="text-sm text-muted-foreground">
                        {t.rich("webhooks.noProjects", {
                            link: (chunks) => (
                                <Link key="deploy" href="/apps/deploy" className="text-primary hover:underline">
                                    {chunks}
                                </Link>
                            )
                        })}
                    </p>
                </div>
            ) : (
                <WatchWebhooks
                    projects={projects.map((project) => ({
                        id: project.id,
                        name: project.name,
                        count: project._count.webhooks
                    }))}
                />
            )}

            <p className="text-xs text-muted-foreground">
                {t.rich("webhooks.personal", {
                    link: (chunks) => (
                        <Link key="prefs" href="/account/notifications" className="text-primary hover:underline">
                            {chunks}
                        </Link>
                    )
                })}
            </p>
        </div>
    );
}
