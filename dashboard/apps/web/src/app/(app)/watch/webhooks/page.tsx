import Link from "next/link";
import { prisma } from "@polaris/db";
import { PageHeader } from "@polaris/ui";
import { WatchWebhooks } from "./watch-webhooks";
import { requirePermission } from "@/lib/session";
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
    const projects = await prisma.project.findMany({
        where: { id: { in: ids } },
        orderBy: { name: "asc" },
        select: { id: true, name: true, _count: { select: { webhooks: true } } }
    });

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
            <PageHeader
                title="Webhooks"
                description="Where deploys are reported. These belong to their project, so they keep working after whoever added them is gone."
            />

            {projects.length === 0 ? (
                <div className="rounded-lg border border-border/60 px-4 py-10 text-center">
                    <p className="text-sm text-muted-foreground">
                        No projects yet.{" "}
                        <Link href="/apps/deploy" className="text-primary hover:underline">
                            Create one in Deploy
                        </Link>
                        .
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
                Alerts that go to you rather than to a project - email, your phone, your own webhooks - are set in{" "}
                <Link href="/account/notifications" className="text-primary hover:underline">
                    notification preferences
                </Link>
                .
            </p>
        </div>
    );
}
