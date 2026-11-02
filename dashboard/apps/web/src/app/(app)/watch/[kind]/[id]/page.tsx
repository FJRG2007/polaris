import { prisma } from "@polaris/db";
import { listHosts } from "@/lib/host-service";
import { LOCAL_SERVER_ID } from "@polaris/core";
import { localServerName } from "@/lib/local-server";
import { addressedServer } from "@/lib/watch/server-route";
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
    // so it is settled here rather than guessed at in the browser, for the subject
    // the address turned out to mean rather than the words in it.
    const breakdowns = (subject: string) =>
        userHasManage(user, MACHINE_PERMISSION).then((canReadMachine) =>
            offeredBreakdowns({ id: user.id, canReadMachine }, { kind, id: subject })
        );

    if (kind === "server") {
        // The reserved subject id is how the samples are filed, not how the
        // machine is addressed. Links that were made before that was true still
        // have to arrive somewhere.
        if (id === LOCAL_HOST_SUBJECT) redirect(`/watch/server/${LOCAL_SERVER_ID}`);

        const [owned, hosts, identity] = await Promise.all([
            listAlarms(user.id),
            listHosts(user.id),
            localMachineIdentity()
        ]);
        const watching = (targetId: string) => owned.filter((alarm) => alarm.targetId === targetId);
        const here = hosts.filter((entry) => isLocalMachine(entry, identity));
        const remote = hosts.filter((entry) => !isLocalMachine(entry, identity));
        const localHost = here[0] ?? null;
        const name = await localServerName(localHost?.name);
        const machine = { id: localHost?.id ?? LOCAL_SERVER_ID, name };

        const addressed = addressedServer(decodeURIComponent(id), LOCAL_SERVER_ID, machine, here, remote);
        if (!addressed) notFound();
        // Old links arrive by id or by the reserved word; the address reads as the name.
        if (addressed.address !== id) redirect(`/watch/server/${encodeURIComponent(addressed.address)}`);

        // The machine Polaris runs on is measured directly rather than over SSH to
        // itself, so its history lives under the local subject whatever the address.
        const { host } = addressed;
        const offered = await breakdowns(host?.id ?? LOCAL_SERVER_ID);
        if (!host) {
            return (
                <WatchSubjectDetail
                    kind="server"
                    id={LOCAL_SERVER_ID}
                    name={name}
                    // Said in the reader's words by the detail screen.
                    detail={
                        localHost
                            ? `${localHost.username}@${localHost.address} - the machine Polaris runs on` // i18n-ignore
                            : "The machine Polaris runs on" // i18n-ignore
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
        return (
            <WatchSubjectDetail
                kind="server"
                id={host.id}
                name={host.name}
                detail={`${host.username}@${host.address}`}
                alarms={watching(host.id)}
                breakdowns={offered}
            />
        );
    }

    const [owned, offered, app] = await Promise.all([
        listAlarms(user.id),
        breakdowns(id),
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
