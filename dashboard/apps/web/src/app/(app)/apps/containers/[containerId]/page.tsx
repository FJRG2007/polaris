import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { containerHosts, selectConnection } from "../connections";
import { ContainerView, type ContainerTab } from "./container-view";

export const dynamic = "force-dynamic";

const TABS = ["details", "logs", "files", "console"] as const;

function pick(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

/** The tab a link asked for, or the one this page opens on. Anything else in the
 *  query is somebody's typo, not a reason to render nothing. */
function pickTab(value: string | string[] | undefined): ContainerTab {
    const requested = pick(value);
    return TABS.find((tab) => tab === requested) ?? "details";
}

/**
 * One container, on its own page rather than in a dialog over the list.
 *
 * The route is the container's name and the host is the query - the same `?c=`
 * the list uses - so a container has an address somebody can send, bookmark, or
 * come back to after a refresh. The name is what Docker calls it and what every
 * API call here accepts in place of an id.
 *
 * The host must be named exactly: falling back to another one, as the list
 * deliberately does, would answer about a different machine's container of the
 * same name. Nothing is asked of the engine here, so the page paints and then
 * fills in.
 */
export default async function ContainerPage({
    params,
    searchParams
}: {
    params: Promise<{ containerId: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const user = await requirePermission("deploy.read");
    const [{ containerId }, query] = await Promise.all([params, searchParams]);
    const hosts = await containerHosts(user);

    const requested = pick(query.c);
    const connection = selectConnection(hosts, requested);
    if (!connection || connection.id !== requested) notFound();

    return (
        <ContainerView
            connection={connection}
            containerRef={decodeURIComponent(containerId)}
            initialTab={pickTab(query.tab)}
            canManage={hosts.canManage}
        />
    );
}
