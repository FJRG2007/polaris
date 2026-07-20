/**
 * Deploy targets: the "where it runs" abstraction that unifies the local host
 * (brokered by polaris-hostd) and remote SSH `Host`s (EC2/VPS). A target carries
 * the per-server runtime engine (compose | swarm) and the shared proxy network
 * its deployed services join. The local target is a real row (so foreign keys
 * hold) seeded lazily per owner; remote targets are created when a Host is
 * adopted into Deploy.
 */

import { prisma } from "@polaris/db";
import { getHostConnection } from "./host-service";

/** Stable display name of every owner's single local target. */
const LOCAL_TARGET_NAME = "Local";

export type DeployRuntime = "compose" | "swarm";

/**
 * The owner's local target, created on first use. Local runs default to compose
 * because the hostd broker drives a single-node engine; swarm is opt-in per
 * target and only meaningful once a node has joined a swarm.
 */
export async function getOrCreateLocalTarget(ownerId: string) {
    const existing = await prisma.deployTarget.findFirst({
        where: { ownerId, kind: "local" }
    });
    if (existing) return existing;
    return prisma.deployTarget.create({
        data: { ownerId, name: LOCAL_TARGET_NAME, kind: "local", runtime: "compose" }
    });
}

/** Adopt an existing SSH `Host` as a deploy target, defaulting new remote
 *  targets to the scalability-oriented swarm engine. Idempotent by (owner, host). */
export async function getOrCreateHostTarget(
    hostId: string,
    ownerId: string,
    name: string,
    runtime: DeployRuntime = "swarm"
) {
    const existing = await prisma.deployTarget.findFirst({
        where: { ownerId, kind: "host", hostId }
    });
    if (existing) return existing;
    return prisma.deployTarget.create({
        data: { ownerId, name, kind: "host", hostId, runtime }
    });
}

export async function listDeployTargets(ownerId: string) {
    return prisma.deployTarget.findMany({
        where: { ownerId },
        orderBy: { createdAt: "asc" }
    });
}

/** Resolve a target to a runnable location: the local broker, or a decrypted SSH
 *  connection for a remote Host (reusing the pinned-key trust from host-service). */
export async function resolveTarget(targetId: string, ownerId: string) {
    const target = await prisma.deployTarget.findFirst({ where: { id: targetId, ownerId } });
    if (!target) throw new Error("Deploy target not found");
    if (target.kind === "local" || !target.hostId) {
        return { target, kind: "local" as const };
    }
    const connection = await getHostConnection(target.hostId, ownerId);
    return { target, kind: "host" as const, connection };
}
