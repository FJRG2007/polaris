/**
 * How the edge reaches a service that runs more than one copy.
 *
 * On plain compose every copy is a container of its own - the first under the
 * service's own name, the others after it (see `replicaNames`) - so the edge is
 * given each by name and balances between them itself, pinning a visitor to one
 * when the service asks and leaving out one that fails its health path. Swarm
 * spreads its own replicas behind one name and one published port, so it is
 * routed the way a single copy is.
 *
 * The names are always the service's own, whichever release is serving: a release
 * started beside the one it replaces answers to them as well (see `expandReplicas`),
 * so a deploy changes what answers on each name and never the route.
 */

import type { AppRoute } from "./router";
import { replicaNames } from "@polaris/deploy";
import type { AppEdgeConfig } from "@polaris/core";

/**
 * Every copy of a service that runs more than one on plain compose, by name, or
 * nothing.
 *
 * As many as the release serving it was started with (`serving`), where that was
 * recorded, rather than the count it is set to: a new count is only running once
 * the release that carries it is, and until then a name for a copy that does not
 * exist yet would be a share of the traffic sent nowhere.
 */
export function copiesOf(
    app: { replicas: number; target: { runtime: string } },
    name: string,
    serving?: { readonly replicas: number | null }
): string[] | undefined {
    const count = serving?.replicas ?? app.replicas;
    return count > 1 && app.target.runtime !== "swarm" ? replicaNames(name, count) : undefined;
}

/** The route fields that spread a service over its copies, with the balancing it
 *  asked for; nothing for a single copy. */
export function balancedOver(
    copies: readonly string[] | undefined,
    edge: AppEdgeConfig | undefined
): Pick<AppRoute, "dialHosts" | "sticky" | "healthPath"> {
    if (!copies || copies.length <= 1) return {};
    return {
        dialHosts: copies,
        sticky: edge?.balancing?.sticky === true,
        ...(edge?.balancing?.healthPath ? { healthPath: edge.balancing.healthPath } : {})
    };
}
