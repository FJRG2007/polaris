import { prisma } from "@polaris/db";
import { listHosts } from "@/lib/host-service";
import { LOCAL_SERVER_ID } from "@polaris/core";
import { listAlarms } from "@/lib/watch-service";
import { notFound, redirect } from "next/navigation";
import { LOCAL_HOST_SUBJECT } from "@/lib/metrics-shared";
import { requirePermission, userHasManage } from "@/lib/session";
import { isLocalMachine, localMachineIdentity } from "@/lib/local-machine";
import { WatchSubjectDetail } from "@/app/(app)/watch/watch-subject-detail";
import { MACHINE_PERMISSION, offeredBreakdowns } from "@/lib/watch/subject-breakdown";

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
    const [{ kind, id }, user] = await Promise.all([params, requirePermission("deploy.read")]);
    if (kind !== "server" && kind !== "service") notFound();

    // Whether a card may be opened to see what is behind it depends on what is
    // deployed here and on how much of the machine this reader is allowed to see,
    // so it is settled here rather than guessed at in the browser. It is asked
    // alongside everything else rather than after it: both are a count or two, and
    // scoped to this reader, so the answer is only discarded when the page turns
    // out to be a redirect or a 404.
    const breakdowns = userHasManage(user, MACHINE_PERMISSION).then((canReadMachine) =>
        offeredBreakdowns({ id: user.id, canReadMachine }, { kind, id })
    );

    if (kind === "server") {
        const [owned, offered, hosts, identity] = await Promise.all([
            listAlarms(user.id),
            breakdowns,
            listHosts(user.id),
            localMachineIdentity()
        ]);
        const watching = (targetId: string) => owned.filter((alarm) => alarm.targetId === targetId);
        const localHost = hosts.find((entry) => isLocalMachine(entry, identity)) ?? null;

        // The reserved subject id is how the samples are filed, not how the
        // machine is addressed. Links that were made before that was true still
        // have to arrive somewhere.
        if (id === LOCAL_HOST_SUBJECT) redirect(`/watch/server/${LOCAL_SERVER_ID}`);

        if (id === LOCAL_SERVER_ID) {
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
                    // An alarm on this machine names the server row it was
                    // enrolled as, or - before it was enrolled - its reserved
                    // subject. Both are this page.
                    alarms={[
                        ...(localHost ? watching(localHost.id) : []),
                        ...watching(LOCAL_HOST_SUBJECT)
                    ]}
                    breakdowns={offered}
                />
            );
        }
        const host = hosts.find((entry) => entry.id === id);
        if (!host) notFound();
        // A server that is the machine Polaris runs on is measured directly rather
        // than over SSH to itself, so its history lives under the local subject.
        // Its own id would open a page with nothing on it.
        if (isLocalMachine(host, identity)) redirect(`/watch/server/${LOCAL_SERVER_ID}`);
        return (
            <WatchSubjectDetail
                kind="server"
                id={id}
                name={host.name}
                detail={`${host.username}@${host.address}`}
                alarms={watching(host.id)}
                breakdowns={offered}
            />
        );
    }

    const [owned, offered, app] = await Promise.all([
        listAlarms(user.id),
        breakdowns,
        prisma.application.findFirst({
            where: { id, environment: { project: { ownerId: user.id } } },
            select: {
                id: true,
                name: true,
                environment: {
                    select: { name: true, projectId: true, project: { select: { name: true } } }
                }
            }
        })
    ]);
    if (!app) notFound();
    const watching = (targetId: string) => owned.filter((alarm) => alarm.targetId === targetId);

    return (
        <WatchSubjectDetail
            kind="service"
            id={app.id}
            name={app.name}
            detail={`${app.environment.project.name} / ${app.environment.name}`}
            projectId={app.environment.projectId}
            serviceHref={`/apps/deploy/${app.environment.projectId}?service=${app.id}`}
            alarms={watching(app.id)}
            breakdowns={offered}
        />
    );
}
