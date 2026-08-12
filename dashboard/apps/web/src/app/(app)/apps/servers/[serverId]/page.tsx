import { ServerDetail } from "./server-detail";
import { findServerRow } from "../server-rows";
import { requirePermission } from "@/lib/session";
import { notFound, redirect } from "next/navigation";
import { LOCAL_SERVER_ID, serverIdSchema } from "@polaris/core";
import { peekServerMetrics } from "@/lib/server-metrics-service";
import { hostRouteId, LOCAL_HOST_SUBJECT } from "@/lib/metrics-shared";
import { HOST_DOCKER_PREFIX, LOCAL_DOCKER_CONNECTION_ID } from "@/lib/docker-service";

export const dynamic = "force-dynamic";

/**
 * One server's page.
 *
 * Only the row is resolved here - a name, an address, how it signs in - because
 * that is a database read and it puts the page on screen at once. Everything that
 * needs the machine (whether it answers, what is eating it, its load over time) is
 * fetched by the view afterwards, so a server that is off or slow still opens.
 *
 * The exception is the reading the process already has of this machine, which is
 * handed to the view rather than left for it to ask for: it costs nothing, and it
 * is the difference between a panel of figures and a panel of skeletons on a first
 * visit, where the browser is holding nothing of its own to paint from.
 *
 * The machine Polaris runs on is addressed as `local` and never by the reserved id
 * its samples are filed under; both the container engine and the metric series for
 * it are reached under that name too, which is why the two ids the view needs are
 * resolved here rather than guessed there.
 */
export default async function ServerPage({ params }: { params: Promise<{ serverId: string }> }) {
    const user = await requirePermission("system.manage");
    const { serverId } = await params;

    // Anything that is neither `local` nor a uuid was never a server, so it is a
    // 404 rather than a lookup.
    const parsed = serverIdSchema.safeParse(serverId);
    if (!parsed.success) notFound();

    const server = await findServerRow(user.id, parsed.data);
    if (!server) {
        // The server somebody enrolled turned out to be this machine, so it is not
        // listed twice - the local row is it. Its own id still has to arrive
        // somewhere, because that is the id every other screen holds it by.
        const localRow = await findServerRow(user.id, LOCAL_SERVER_ID);
        if (localRow?.hostId === parsed.data) redirect(`/apps/servers/${LOCAL_SERVER_ID}`);
        notFound();
    }

    // Read, never probed: a page must not wait on an SSH session to a machine that
    // may be off. Null when nothing has read this server recently, and then the
    // view fills the panel in as its own request lands.
    const cached = server.hostId ? peekServerMetrics(server.hostId) : null;

    return (
        <ServerDetail
            server={server}
            initialUsage={cached ? { at: cached.at, value: cached.metrics } : undefined}
            connectionId={
                server.kind === "local" ? LOCAL_DOCKER_CONNECTION_ID : `${HOST_DOCKER_PREFIX}${server.id}`
            }
            // A registered server that turned out to be this machine is folded into
            // the local row upstream, so a host row here is always a remote one and
            // its series is its own.
            metricsId={server.kind === "local" ? hostRouteId(LOCAL_HOST_SUBJECT) : server.id}
        />
    );
}
