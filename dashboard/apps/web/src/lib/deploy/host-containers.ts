/**
 * Containers Polaris put on this machine and no longer has a record of.
 *
 * Polaris is responsible for what it deploys, and that has to include what it
 * stops deploying. A service removed from a project, a stack recreated under a
 * new name, a release that outlived the record of it - each leaves a container
 * sitting on the disk holding its image, its writable layer and its ports, and
 * nothing in Polaris ever mentions it again. The operator finds them in
 * `docker ps` and removes them by hand, which is the one thing this product
 * promises they will never have to do.
 *
 * The rule for calling one abandoned is deliberately narrow, because the cost of
 * being wrong is deleting something that was running for a reason:
 *
 *   - Its compose project has to be exactly the shape Polaris gives an
 *     application: `polaris-<eight hex>`, optionally with a release marker after
 *     it. That is `releases.ts`'s own naming, so nothing but a deployed service
 *     can match it - Polaris's own stack, the tunnels (`polaris-ntunnel-...`,
 *     `polaris-qtunnel-...`, `polaris-ngrok-...`) and anything an operator
 *     started themselves all fail the pattern.
 *   - The hash has to match no application Polaris holds. The hash is one way,
 *     so the applications are hashed and looked up rather than the project being
 *     decoded.
 *
 * Nothing is removed automatically and nothing is pruned. They are listed, with
 * what they are and whether they are still running, and go one at a time from a
 * button - the same shape a volume goes in, and for the same reason: this is
 * Polaris saying what it believes, and a person deciding.
 *
 * Server-only.
 */

import { HostdClient } from "@polaris/hostd-client";
import { findLeftovers, knownAppProjects, liveContainers } from "./uninstall-leftovers";

/** One container Polaris left behind, as a screen shows it. */
export interface StrayContainer {
    readonly id: string;
    readonly name: string;
    readonly image: string;
    /** The compose project it was deployed under. */
    readonly project: string;
    readonly running: boolean;
    /** What the daemon says about it - "Exited (0) 3 weeks ago". */
    readonly status: string;
    readonly createdAt: string | null;
}

/**
 * Every container on this machine whose project is an application's and whose
 * application is gone.
 *
 * Null - never an empty list - when the daemon will not answer, or when the
 * applications cannot be read: an empty answer from a database that did not
 * answer would make every application on the machine look abandoned.
 */
export async function strayContainers(): Promise<StrayContainer[] | null> {
    const reply = await new HostdClient()
        .dockerRequest("GET", "/containers/json?all=1")
        .catch(() => null);
    if (!reply || reply.status !== 200) return null;

    let listing: unknown[];
    try {
        const parsed: unknown = JSON.parse(reply.body);
        if (!Array.isArray(parsed)) return null;
        listing = parsed;
    } catch {
        return null;
    }

    const appProjects = await knownAppProjects();
    if (!appProjects) return null;
    // Only the shape an application runs under. Polaris's own stack and its
    // tunnels are named differently on purpose, and an operator's own container
    // never carries this label at all.
    return [
        ...findLeftovers(
            {
                containers: liveContainers(listing as Parameters<typeof liveContainers>[0]),
                networks: null,
                dirs: null,
                routes: null
            },
            { appProjects, wantedNetworks: null, domainIds: null }
        ).containers
    ];
}

/** Why a container was not removed, in the terms the screen says it in. */
export type ContainerRemoval = { ok: true } | { ok: false; reason: string };

/**
 * Remove one container Polaris left behind, named in full.
 *
 * Re-checked here rather than trusted from the screen: the list it was chosen
 * from is a picture of a moment, and a deploy since then may have made the
 * application it belongs to real again.
 *
 * Its volumes are deliberately left where they are. `v=1` on this call would
 * take them with it, and a volume is the one thing on this machine that does not
 * come back - they are listed on the same screen, with their sizes, and go one
 * at a time like everything else here.
 */
export async function removeStrayContainer(id: string): Promise<ContainerRemoval> {
    const strays = await strayContainers();
    if (!strays) return { ok: false, reason: "This machine would not say what it is running." };
    const stray = strays.find((entry) => entry.id === id);
    if (!stray) return { ok: false, reason: "That container is not on this machine any more." };

    const reply = await new HostdClient()
        // Forced, because a stray that is still running is exactly the case this
        // exists for - and never `v=1`: what it wrote stays until somebody says
        // otherwise.
        .dockerRequest("DELETE", `/containers/${encodeURIComponent(id)}?force=1&v=0`)
        .catch(() => null);
    if (!reply) return { ok: false, reason: "This machine would not answer. Nothing was removed." };
    if (reply.status === 204) return { ok: true };
    if (reply.status === 404)
        return { ok: false, reason: "That container is not on this machine any more." };
    if (reply.status === 409)
        return { ok: false, reason: "The machine is busy with it. Nothing was removed." };
    return { ok: false, reason: "This machine refused to remove it." };
}
