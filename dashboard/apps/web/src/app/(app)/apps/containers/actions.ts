"use server";

/**
 * Containers app server actions. Connection management and lifecycle controls are
 * gated on system.manage and re-validated server-side; the client never drives a
 * Docker operation it is not entitled to. New connections are ping-tested before
 * they are saved so a bad transport fails fast with a clear message.
 */

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { withDockerDriver } from "@/lib/container-service";
import { createDockerConnectionSchema, createDockerDriver } from "@polaris/docker";
import {
    createDockerConnection,
    deleteDockerConnection,
    HOST_DOCKER_PREFIX,
    LOCAL_DOCKER_CONNECTION_ID
} from "@/lib/docker-service";
import * as queue from "@/lib/agent-rollouts/queue";
import { getTranslations } from "@/lib/i18n/request";
import type { NamespaceKey } from "@/lib/i18n/types";
import * as rollouts from "@/lib/agent-rollouts/service";

type ContainersKey = NamespaceKey<"containers">;

/** A reply in the reader's language. */
async function say(key: ContainersKey): Promise<string> {
    return (await getTranslations("containers"))(key);
}

/** What went wrong, for the reader: a service's own sentence passes through, and
 *  anything that is not an Error reads as `fallback`. */
async function failure(caught: unknown, fallback: ContainersKey): Promise<string> {
    return caught instanceof Error ? caught.message : say(fallback);
}

const CONTAINERS_PATH = "/apps/containers";

export async function createDockerConnectionAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = createDockerConnectionSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? (await say("errors.invalidConnection")) };

    // Validate connectivity before persisting.
    try {
        const probe = createDockerDriver({
            id: "probe",
            config: parsed.data.config,
            credentials: parsed.data.credentials
        });
        const ok = await probe.ping();
        await probe.dispose();
        if (!ok) return { error: await say("errors.engineUnreachable") };
    } catch (caught) {
        return { error: await failure(caught, "errors.connectionFailed") };
    }

    const created = await createDockerConnection(
        user.id,
        parsed.data.name,
        parsed.data.config,
        parsed.data.credentials
    );
    await recordAudit({
        actorId: user.id,
        action: "docker.connection.create",
        targetType: "docker",
        targetId: created.id,
        metadata: { name: parsed.data.name, transport: parsed.data.config.transport }
    });
    revalidatePath(CONTAINERS_PATH);
    return {};
}

export async function deleteDockerConnectionAction(connectionId: string): Promise<void> {
    const user = await requirePermission("system.manage");
    // The local host and global Hosts are not stored Docker rows here (Hosts are
    // managed in the Servers app), so there is nothing to remove.
    if (connectionId === LOCAL_DOCKER_CONNECTION_ID || connectionId.startsWith(HOST_DOCKER_PREFIX)) return;
    await deleteDockerConnection(user.id, connectionId);
    await recordAudit({ actorId: user.id, action: "docker.connection.delete", targetType: "docker", targetId: connectionId });
    revalidatePath(CONTAINERS_PATH);
}

export async function containerAction(
    connectionId: string,
    containerId: string,
    action: "start" | "stop" | "restart"
): Promise<{ error?: string; queued?: boolean }> {
    const user = await requirePermission("system.manage");
    try {
        await withDockerDriver(connectionId, user.id, async (driver) => {
            if (action === "start") await driver.start(containerId);
            else if (action === "stop") await driver.stop(containerId);
            else await driver.restart(containerId);
        });
    } catch (caught) {
        // One of Polaris's own servers that is not answering keeps the command
        // until it is back, instead of the click being lost.
        const queued = await queueForLater(connectionId, containerId, action, user.id);
        if (queued) return { queued: true };
        return { error: await failure(caught, "errors.actionFailed") };
    }
    await recordAudit({
        actorId: user.id,
        action: `docker.container.${action}`,
        targetType: "container",
        targetId: containerId,
        metadata: { connectionId }
    });
    revalidatePath(CONTAINERS_PATH);
    return {};
}

async function queueForLater(
    connectionId: string,
    containerId: string,
    action: "start" | "stop" | "restart",
    actorId: string
): Promise<boolean> {
    const serverId = rollouts.serverOfConnection(connectionId);
    const command = queue.commandSchema.safeParse({ kind: `container.${action}`, container: containerId });
    if (!serverId || !command.success) return false;
    try {
        if (!(await rollouts.queueIfOffline(serverId, command.data, actorId))) return false;
    } catch (error) {
        // A full queue or a vanished server: the original failure is the answer.
        if (!(error instanceof rollouts.RolloutRefusal)) console.error("polaris: queueing a container action failed:", error);
        return false;
    }
    await recordAudit({
        actorId,
        action: "server.command.queue",
        targetType: "server",
        targetId: serverId,
        metadata: { kind: command.data.kind, container: containerId }
    });
    return true;
}

/**
 * Remove a container. `force` is what makes removing a running one possible;
 * named volumes are never touched, and the anonymous ones a container owns go
 * only when the caller asked - deleting data nobody asked to delete is the one
 * mistake here that cannot be undone.
 */
export async function removeContainerAction(
    connectionId: string,
    containerId: string,
    options: { force: boolean; volumes: boolean }
): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    try {
        await withDockerDriver(connectionId, user.id, (driver) => driver.remove(containerId, options));
    } catch (caught) {
        return { error: await failure(caught, "errors.removeFailed") };
    }
    await recordAudit({
        actorId: user.id,
        action: "docker.container.remove",
        targetType: "container",
        targetId: containerId,
        metadata: { connectionId, force: options.force, volumes: options.volumes }
    });
    revalidatePath(CONTAINERS_PATH);
    return {};
}
