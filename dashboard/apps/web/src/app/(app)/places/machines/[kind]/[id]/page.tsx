import { listHosts } from "@/lib/host-service";
import { LOCAL_SERVER_ID } from "@polaris/core";
import { notFound, redirect } from "next/navigation";
import { LOCAL_HOST_SUBJECT } from "@/lib/metrics-shared";
import { MachineDetailView } from "./machine-detail-view";
import * as machines from "@/lib/machines/machines-service";
import { requirePermission, userHasManage } from "@/lib/session";
import { isLocalMachine, localMachineIdentity } from "@/lib/local-machine";
import { MACHINE_PERMISSION, offeredBreakdowns } from "@/lib/watch/subject-breakdown";

export const dynamic = "force-dynamic";

/**
 * One server, container or domain, opened as a device: its load and what is
 * behind it, and the days its alarms were firing. The same subjects and the same
 * owner scope as Watch, which this replaces.
 */
export default async function MachinePage({ params }: { params: Promise<{ kind: string; id: string }> }) {
    const [{ kind, id: raw }, user] = await Promise.all([params, requirePermission("deploy.read")]);
    const id = decodeURIComponent(raw);

    if (kind === "server") {
        if (id === LOCAL_HOST_SUBJECT) redirect(`/places/machines/server/${LOCAL_SERVER_ID}`);
        const [hosts, identity, canReadMachine] = await Promise.all([
            listHosts(user.id),
            localMachineIdentity(),
            userHasManage(user, MACHINE_PERMISSION)
        ]);
        const localHost = hosts.find((entry) => isLocalMachine(entry, identity)) ?? null;
        const host = id === LOCAL_SERVER_ID ? localHost : hosts.find((entry) => entry.id === id);
        if (id !== LOCAL_SERVER_ID && !host) notFound();
        if (id !== LOCAL_SERVER_ID && host && isLocalMachine(host, identity)) {
            redirect(`/places/machines/server/${LOCAL_SERVER_ID}`);
        }
        // An alarm on the local machine names the server row it was enrolled as,
        // or - before it was - its reserved subject. Both are this page.
        const targets = id === LOCAL_SERVER_ID ? [...(localHost ? [localHost.id] : []), LOCAL_HOST_SUBJECT] : [id];
        const [breakdowns, history] = await Promise.all([
            offeredBreakdowns({ id: user.id, canReadMachine }, { kind: "server", id }),
            machines.machineAlarmEvents(user.id, targets)
        ]);
        return (
            <MachineDetailView
                kind="server"
                id={id}
                // i18n-ignore the same word in both languages
                name={host?.name ?? "Local"}
                detail={host ? `${host.username}@${host.address}` : null}
                breakdowns={breakdowns}
                history={history}
            />
        );
    }

    if (kind === "container") {
        const card = (await machines.machineContainers(user.id)).find((entry) => entry.id === id);
        if (!card) notFound();
        return <MachineDetailView kind="container" id={id} name={card.name} detail={card.detail} container={card} />;
    }

    if (kind === "domain") {
        if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
        const [domain] = await machines.machineDomains(user.id, id);
        if (!domain) notFound();
        const history = await machines.machineAlarmEvents(user.id, [domain.id]);
        return (
            <MachineDetailView
                kind="domain"
                id={id}
                name={domain.hostname}
                detail={domain.service}
                domain={domain}
                history={history}
            />
        );
    }

    notFound();
}
