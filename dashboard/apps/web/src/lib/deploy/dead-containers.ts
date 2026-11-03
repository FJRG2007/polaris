/**
 * Containers Polaris started that no longer serve anything, removed by Polaris.
 *
 * Every feature takes its own container down when it is switched off or its
 * owner is deleted - but each of them swallows a teardown that fails, because the
 * person is answered either way, and a daemon that did not answer at that moment
 * left the container there for good. This is the pass that looks again, starting
 * from what the machine holds rather than from what the database says ended.
 *
 * What counts as dead is deliberately narrow, because the cost of being wrong is
 * removing something that was running for a reason:
 *
 *   - a tunnel given to a deployed service (`polaris-ntunnel-<hash>`,
 *     `polaris-qtunnel-<hash>`, `polaris-ngrok-<hash>`) whose service is gone;
 *   - the account tunnel (`polaris-tunnel`) while no provider is switched on in
 *     Integrations;
 *   - a deployed service's own containers, networks, folders and routes when the
 *     service is gone - `cleanLeftovers`, the same clean-up the storage screen's
 *     button runs.
 *
 * Never a container without one of those exact projects, never one whose owner
 * is present and switched on (an idle tunnel is not a dead one), never one made
 * in the last few minutes, and never a volume: a removed service's data is
 * `leftover-volumes`' call, with its own week and its own switch. The share and
 * backup tunnels are settled by their own passes, which know when they are
 * wanted, and are left to them.
 *
 * A pass is skipped while anything on this machine is pulling or building, and
 * does nothing when the machine will not say what it runs - a limited edition
 * has no daemon to ask. Each removal is written to the activity log, and the
 * people who manage the server are told once per pass.
 *
 * Server-only. Safe to re-run.
 */

import { HostdClient } from "@polaris/hostd-client";
import { sidecarOf, type SidecarFeature } from "@polaris/deploy";

import { DEFAULT_LOCALE } from "@polaris/core";
import { recordAudit } from "@/lib/audit-service";
import { translatorFor } from "@/lib/i18n/translate";
import { accountTunnelWanted } from "@/lib/tunnel-service";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { notifyOperators } from "@/lib/notifications/operators";
import { ImageStoreBusy, LOCAL_MACHINE, withImagePrune } from "./image-store-lock";
import {
    cleanLeftovers,
    knownAppProjects,
    liveContainers,
    type LiveContainer
} from "./uninstall-leftovers";

/** How long a new container is left alone: its owner's row may still be on its
 *  way, and a feature being switched on writes its setting before it starts. */
export const DEAD_GRACE_MS = 10 * 60_000;

/** What a container's owner is, as this pass read it. Null is "could not be
 *  read", and nothing that depends on it is removed. */
export interface ReaperOwners {
    /** Every deployed service's compose project, `polaris-<hash of its id>`. */
    readonly appProjects: ReadonlySet<string> | null;
    /** Whether a provider is switched on for the account tunnel. */
    readonly accountTunnel: boolean | null;
}

export type DeadReason = "owner-gone" | "feature-off";

export interface DeadContainer {
    readonly id: string;
    readonly name: string;
    readonly project: string;
    readonly feature: SidecarFeature;
    readonly reason: DeadReason;
}

/** Why one sidecar has to go, or null when it stays. */
function deathOf(feature: SidecarFeature, appProject: string | undefined, owners: ReaperOwners) {
    switch (feature) {
        case "app-tunnel-named":
        case "app-tunnel-quick":
        case "app-tunnel-ngrok":
            return owners.appProjects && appProject && !owners.appProjects.has(appProject)
                ? ("owner-gone" as const)
                : null;
        case "tunnel-ngrok":
        case "tunnel-cloudflare":
            return owners.accountTunnel === false ? ("feature-off" as const) : null;
        default:
            // The share and backup tunnels: their own passes decide.
            return null;
    }
}

/**
 * The sidecars to remove: Polaris's own, past the grace, whose owner is gone or
 * whose feature is switched off. Pure, so every branch can be asserted without a
 * daemon.
 */
export function deadSidecars(
    containers: readonly LiveContainer[],
    owners: ReaperOwners,
    now: Date
): DeadContainer[] {
    const dead: DeadContainer[] = [];
    for (const container of containers) {
        const sidecar = sidecarOf(container.project, container.image);
        if (!sidecar) continue;
        // No creation time is no proof it is old.
        const made = container.createdAt ? Date.parse(container.createdAt) : NaN;
        if (!Number.isFinite(made) || now.getTime() - made < DEAD_GRACE_MS) continue;
        const reason = deathOf(sidecar.feature, sidecar.appProject, owners);
        if (!reason) continue;
        dead.push({
            id: container.id,
            name: container.name,
            project: sidecar.project,
            feature: sidecar.feature,
            reason
        });
    }
    return dead.sort((left, right) => left.name.localeCompare(right.name));
}

/** What one pass removed. */
export interface ReaperPass {
    readonly sidecars: readonly DeadContainer[];
    /** Containers of deleted services, from `cleanLeftovers`. */
    readonly leftovers: number;
}

const NOTHING: ReaperPass = { sidecars: [], leftovers: 0 };

async function listing(daemon: HostdClient): Promise<LiveContainer[] | null> {
    const reply = await daemon.dockerRequest("GET", "/containers/json?all=1").catch(() => null);
    if (!reply || reply.status !== 200) return null;
    try {
        const parsed: unknown = JSON.parse(reply.body);
        return Array.isArray(parsed)
            ? liveContainers(parsed as Parameters<typeof liveContainers>[0])
            : null;
    } catch {
        return null;
    }
}

async function pass(now: Date): Promise<ReaperPass> {
    const daemon = new HostdClient();
    const containers = await listing(daemon);
    // A machine that will not say what it runs is not a machine running nothing.
    if (!containers) return NOTHING;
    const owners: ReaperOwners = {
        appProjects: await knownAppProjects().catch(() => null),
        accountTunnel: await accountTunnelWanted().catch(() => null)
    };

    const removed: DeadContainer[] = [];
    for (const dead of deadSidecars(containers, owners, now)) {
        // Forced, since a sidecar that is still running is exactly the case, and
        // never `v=1`: none of these hold data, but nothing here removes volumes.
        const reply = await daemon
            .dockerRequest("DELETE", `/containers/${encodeURIComponent(dead.id)}?force=1&v=0`)
            .catch(() => null);
        if (reply?.status !== 204 && reply?.status !== 404) continue;
        removed.push(dead);
        console.log(`polaris: removed ${dead.name} (${dead.feature}, ${dead.reason})`);
        await recordAudit({
            actorId: null,
            action: "server.container.removed",
            targetType: "container",
            targetId: dead.name,
            metadata: {
                project: dead.project,
                feature: dead.feature,
                reason: dead.reason,
                automatic: true
            }
        });
    }

    const cleaned = await cleanLeftovers().catch(() => null);
    const leftovers = cleaned?.removed.containers ?? 0;
    if (leftovers > 0) {
        console.log(`polaris: removed ${leftovers} container(s) of deleted services`);
        await recordAudit({
            actorId: null,
            action: "server.leftovers.removed",
            targetType: "server",
            metadata: { ...cleaned?.removed, automatic: true }
        });
    }
    return { sidecars: removed, leftovers };
}

/** Remove every dead Polaris container on this machine, and say what went. */
export async function reapDeadContainers(now = new Date()): Promise<number> {
    let result: ReaperPass;
    try {
        // Held like a prune, and skipped rather than queued while a pull or a
        // build is running: the deploy keeping the machine busy is itself what
        // may be about to make one of these owners real again.
        result = await withImagePrune(LOCAL_MACHINE, () => pass(now), { whenIdle: true });
    } catch (error) {
        if (error instanceof ImageStoreBusy) return 0;
        throw error;
    }
    const count = result.sidecars.length + result.leftovers;
    if (count === 0) return 0;

    const say = (t: NamespaceTranslator<"notices">) => ({
        title: t("deadContainers.title", { count }),
        body: [
            ...result.sidecars.map((dead) =>
                t("deadContainers.line", {
                    name: dead.name,
                    feature: t(`deadContainers.feature.${dead.feature}`),
                    reason: t(`deadContainers.reason.${dead.reason}`)
                })
            ),
            ...(result.leftovers > 0
                ? [t("deadContainers.leftovers", { count: result.leftovers })]
                : [])
        ].join("\n")
    });
    await notifyOperators({
        permission: "system.manage",
        event: "server.space",
        ...say(translatorFor(DEFAULT_LOCALE, "notices")),
        say,
        href: "/apps/servers"
    }).catch(() => undefined);
    return count;
}
