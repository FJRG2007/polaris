import { prisma } from "@polaris/db";
import { listHosts } from "@/lib/host-service";
import { listAlarms } from "@/lib/watch-service";
import { requirePermission } from "@/lib/session";
import { notFound, redirect } from "next/navigation";
import { LOCAL_HOST_SUBJECT } from "@/lib/metrics-shared";
import { isLocalMachine, localDockerId } from "@/lib/local-machine";
import { WatchSubjectDetail } from "@/app/(app)/watch/watch-subject-detail";

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
        const [hosts, localId] = await Promise.all([listHosts(user.id), localDockerId()]);
        const localHost = hosts.find((entry) => isLocalMachine(entry, localId)) ?? null;

        if (id === LOCAL_HOST_SUBJECT) {
            return (
                <WatchSubjectDetail
                    kind="server"
                    id={id}
                    name={localHost?.name ?? "Local"}
                    detail={
                        localHost
                            ? `${localHost.username}@${localHost.address} - the machine Polaris runs on`
                            : "The machine Polaris runs on"
                    }
                    alarms={alarms}
                />
            );
        }
        const host = hosts.find((entry) => entry.id === id);
        if (!host) notFound();
        // A server that is the machine Polaris runs on is measured directly rather
        // than over SSH to itself, so its history lives under the local subject.
        // Its own id would open a page with nothing on it.
        if (isLocalMachine(host, localId)) redirect(`/watch/server/${LOCAL_HOST_SUBJECT}`);
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
