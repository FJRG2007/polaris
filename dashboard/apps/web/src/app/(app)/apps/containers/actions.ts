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

const CONTAINERS_PATH = "/apps/containers";

export async function createDockerConnectionAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = createDockerConnectionSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid connection" };

    // Validate connectivity before persisting.
    try {
        const probe = createDockerDriver({
            id: "probe",
            config: parsed.data.config,
            credentials: parsed.data.credentials
        });
        const ok = await probe.ping();
        await probe.dispose();
        if (!ok) return { error: "Could not reach the Docker Engine with these settings" };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Connection failed" };
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
): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    try {
        await withDockerDriver(connectionId, user.id, async (driver) => {
            if (action === "start") await driver.start(containerId);
            else if (action === "stop") await driver.stop(containerId);
            else await driver.restart(containerId);
        });
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Action failed" };
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
        return { error: caught instanceof Error ? caught.message : "Could not remove this container" };
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
