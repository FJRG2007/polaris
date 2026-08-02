import { prisma } from "@polaris/db";
import { notFound } from "next/navigation";
import { listHosts } from "@/lib/host-service";
import { listAlarms } from "@/lib/watch-service";
import { requirePermission } from "@/lib/session";
import { LOCAL_HOST_SUBJECT } from "@/lib/metrics-shared";
import { WatchSubjectDetail } from "../../watch-subject-detail";

export const dynamic = "force-dynamic";

/**
 * One monitored thing, opened: its full metric history, the alarms watching it,
 * and - for a service - where its project reports deploys.
 *
 * Only servers and services get a page. A container is not a stable subject (a
 * redeploy replaces it), so its card links to the Containers app, which is where
 * acting on one belongs.
 */
export default async function WatchSubjectPage({
    params
}: {
    params: Promise<{ kind: string; id: string }>;
}) {
    const { kind, id } = await params;
    const user = await requirePermission("deploy.read");
    if (kind !== "server" && kind !== "service") notFound();

    const alarms = (await listAlarms(user.id)).filter((alarm) => alarm.targetId === id);

    if (kind === "server") {
        if (id === LOCAL_HOST_SUBJECT) {
            return (
                <WatchSubjectDetail
                    kind="server"
                    id={id}
                    name="Local"
                    detail="The machine Polaris runs on"
                    alarms={alarms}
                />
            );
        }
        const host = (await listHosts(user.id)).find((entry) => entry.id === id);
        if (!host) notFound();
        return (
            <WatchSubjectDetail
                kind="server"
                id={id}
                name={host.name}
                detail={`${host.username}@${host.address}`}
                alarms={alarms}
            />
        );
    }

    const app = await prisma.application.findFirst({
        where: { id, environment: { project: { ownerId: user.id } } },
        select: {
            id: true,
            name: true,
            environment: { select: { name: true, projectId: true, project: { select: { name: true } } } }
        }
    });
    if (!app) notFound();

    return (
        <WatchSubjectDetail
            kind="service"
            id={app.id}
            name={app.name}
            detail={`${app.environment.project.name} / ${app.environment.name}`}
            projectId={app.environment.projectId}
            serviceHref={`/apps/deploy/${app.environment.projectId}?service=${app.id}`}
            alarms={alarms}
        />
    );
}
